// P09ba: K1's admission transaction start (D2-D5), the fenced completion (D7/D8a-c), C1's CAS and the
// counter union. P09bb: compensation C2-C4, the outcome classifier, durable release, the sweep and the admission record.
// Policy, wire reservation, wire completion, outcome inspection and sink evidence are doubles; P12b1 reruns the D5 cases on
// the real journal. The null-end fence case uses the real wire journal and so needs a root-owned `/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalize, compositeVerificationAddress, generateCanonicalJobId, identityBundleHash } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION, inspectWireOperation, openWireRequestJournal,
  completeWireEffect, wireOperationBinding, wireOperationId } from '@kynesyslabs/dacs/wire';
import { journalStore, reserveEffect } from '../../../dist/wire/journal.js';
import { SELLER_PROFILE, SESSION_CHALLENGE_LIFETIME_MS } from '../src/dacs/session-admission.mjs';
import { createSellerContextAdmission, parsePolicyLedger, releaseSellerContextHolds } from '../src/devnet-demo/operator-approval.mjs';

const T0 = Date.UTC(2026, 9, 27, 12), HOUR = 3600000, POLICY_MS = 10000;
const hash = text => createHash('sha256').update(String(text)).digest('hex');
const job = index => generateCanonicalJobId({ timestamp: T0, entropy: Buffer.alloc(10, index) });
const claim = seed => {
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  return 'did:demos:agent:' + createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
};
const BUYER = claim(1), SELLER = claim(2), OTHER = claim(4), EQUIVALENT_BUYER = `${BUYER}?jurisdiction=GB`;
const PIN = { listingId: 'tp1-vector-listing', version: 1, contentHash: hash('contracts-vector-listing') };
const PROFILE = Object.freeze({ id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION,
  chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion });
const outcome = { status: 200, text: ' {"disposition":"present","fixture":true} ' };
// What the sink answers for a context: the scope the row names, and each party's Vet record reference.
const SCOPE = { agreement: 'context-scope-vector' };
const vetRef = tag => ({ vetRecordRef: { anchor: { kind: 'storage-program', locator: `vet-${tag}` }, contentHash: hash(tag) } });
const presented = (jobId, input = {}, scope = SCOPE) => ({ status: 200, text: JSON.stringify({ disposition: 'present', value: { scope, input: { jobId, buyer: vetRef('buyer'), seller: vetRef('seller'), ...input } } }) });
// The agent stores a Vet non-pass as a 200 context answer (transportOutcome does not count that code as a rejection).
const nonPass = { status: 200, text: JSON.stringify({ disposition: 'rejected', reason: 'buyer Vet decision: fail', code: 'party_vet_non_pass', errorClass: 'permanent' }) };
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise(resolve => setImmediate(resolve));
let createContextAdmissionTransaction, admissionTransactionInternals, sellerStoreInternals, createSellerTransportStore, SELLER_CONTEXT_PATH, importFailure;
try {
  ({ createContextAdmissionTransaction, admissionTransactionInternals } = await import('../src/dacs/seller-admission-transaction.mjs'));
  ({ createSellerTransportStore, sellerStoreInternals, SELLER_CONTEXT_PATH } = await import('../src/dacs/seller-transport-auth.mjs'));
  if (typeof sellerStoreInternals !== 'function') throw new Error('sellerStoreInternals is not exported');
} catch (error) { importFailure = error; }

// A store, a policy double and a wire double on one clock. `reopen()` is a restart: the old handle closes
// and the durable rows are all that remains. `cut(at, when)` fails the next commit for which `when()` holds,
// before it or just after it.
function world(t, config = {}) {
  assert.ifError(importFailure);
  const directory = mkdtempSync(join(tmpdir(), 'TEST-context-admission-'));
  const path = join(directory, 'transport.sqlite'), holds = new Set();
  const calls = { validation: 0, reserve: 0, release: 0, effective: 0, wire: 0, vet: 0, complete: [], evidence: [] };
  const control = { clock: T0, ready: true, beforeReserve: null, releaseFault: null, generation: 0, reserved: [], evidence: null, inspect: null, killed: false, unavailable: null };
  const options = { maxContextRecords: 20, contextStartLimits: { maxStartsPerHour: 12, maxStartsPerBuyerPerHour: 5 }, ...config };
  const defaultPolicy = {
    async reserve(request) { calls.reserve++; control.reserved.push(request); holds.add(request.hold); return control.beforeReserve ? control.beforeReserve() : null; },
    async release({ hold }) {
      calls.release++; if (control.unavailable) throw control.unavailable;
      if (holds.delete(hold)) calls.effective++;
      if (control.releaseFault) throw control.releaseFault;
    },
  };
  const wire = { ends: new Map(), latest: -1 };
  const sameEnd = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const doubleCompleteWire = (effect, answer) => {
    if (effect.attempt !== wire.latest) throw Object.assign(new Error('superseded'), { code: 'seller_effect_superseded' });
    if (wire.ends.has(effect.attempt) && !sameEnd(wire.ends.get(effect.attempt), answer)) throw Object.assign(new Error('conflict'), { code: 'seller_effect_conflict' });
    calls.complete.push({ effect, outcome: answer }); wire.ends.set(effect.attempt, answer);
  };
  // The default evidence is no intent at both retained presenter addresses; the default inspection sees an outcome the wire double holds.
  const evidenceOf = (record, kind) => [record.vetAddresses.buyer, record.vetAddresses.seller].map(address => ({ address, kind }));
  const publishedView = jobId => {
    const outcomes = [...wire.ends.values()].filter(end => end !== null);
    return outcomes.length === 0 ? { state: 'none' } : { state: 'completed', binding: row(jobId).contextBinding, outcome: outcomes.at(-1) };
  };
  let store, admission, internals;
  function reopen() {
    if (!control.killed) store?.close();
    control.killed = false;
    store = createSellerTransportStore({ path, generation: `test-generation-${++control.generation}`, now: () => control.clock, ready: () => control.ready,
      maxContextRecords: options.maxContextRecords, maxJobs: options.maxJobs, contextRecords: options.contextRecords, contextSessionState: options.contextSessionState, wireOperationView: options.wireOperationView, contextStartLimits: options.contextStartLimits });
    internals = sellerStoreInternals(store);
    admission = createContextAdmissionTransaction({ store, policy: options.policy ?? defaultPolicy, capacity: options.capacity ?? null,
      effectEvidence: async record => { calls.evidence.push(record.vetAddresses); return control.evidence ? control.evidence(record) : evidenceOf(record, 'no-intent'); },
      inspectContextOutcome: jobId => (control.inspect ? control.inspect(jobId) : publishedView(jobId)), completeWire: options.completeWire ?? doubleCompleteWire,
      now: () => control.clock, ready: () => control.ready, deadlines: { policyMs: POLICY_MS } });
  }
  reopen();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  function prepare(index = 0x11, buyer = BUYER, { presenter = buyer, issued = null } = {}) {
    const jobId = job(index), challengeScopeHash = hash('challenge-scope');
    const { sessionNonce: nonce } = issued ?? store.challenges.issue({ jobId, buyer }, challengeScopeHash);
    const bundle = { presentedBy: presenter, sessionNonce: nonce, presentation: { proof: 'TEST-fixture' } };
    const attempt = { nonce, jobId, buyer, challengeScopeHash, presentationHash: hash(canonicalize(bundle)), path: 'context' };
    const result = store.challenges.attempt(attempt); assert.equal(result.kind, 'validate'); calls.validation++;
    // The ledger stores only the canonical bytes of the presentation the row was attempted with, under that bundle's identity hash.
    const bundleHash = identityBundleHash(bundle);
    const accepted = { buyerBundleText: canonicalize(bundle), buyerBundleHash: bundleHash, admission: {
      disposition: 'admitted', jobId, buyer: presenter, buyerBundleHash: bundleHash, listingPin: PIN,
      participants: [{ role: 'buyer', claim: presenter, ...SELLER_PROFILE }, { role: 'seller', claim: SELLER, ...SELLER_PROFILE }] },
      firstAdmission: { challengeExpiresAt: control.clock + 600000, generatedAt: control.clock, checkedAt: control.clock } };
    const input = { jobId, buyer, seller: SELLER, listingPin: PIN, contextScopeHash: hash(canonicalize(SCOPE)), nonce, presentationHash: attempt.presentationHash,
      owner: result.owner, accepted, sellerBundlePresentedBy: SELLER, delegationExpiresAt: control.clock + HOUR, purchaseProfile: PROFILE };
    return { input, attempt };
  }
  // The journal's first attempt is 0; every later one is a recovery.
  async function reserveWire() {
    calls.wire++; const attempt = ++wire.latest;
    return Object.freeze({ state: attempt === 0 ? 'new' : 'recover', operationId: hash('wire-operation'), attempt, leaseUntil: control.clock + 300000 });
  }
  // A start of the earlier admission table, which counts beside the K1 rows (SA-5).
  function legacyStart(index, buyer = BUYER, at = T0) {
    internals.db.exec('CREATE TABLE IF NOT EXISTS peer_context_admissions (job TEXT PRIMARY KEY, buyer TEXT, seller TEXT, listing_pin TEXT, scope_hash TEXT, effect TEXT, admitted_at INTEGER)');
    internals.db.prepare('INSERT INTO peer_context_admissions VALUES (?, ?, ?, ?, ?, ?, ?)').run(job(index), buyer, SELLER, JSON.stringify(PIN), hash('scope'), hash('old-effect' + index), at);
  }
  const row = jobId => {
    const found = internals.db.prepare('SELECT record FROM kit_context_admissions WHERE jobId = ?').get(jobId);
    return found ? JSON.parse(found.record) : null;
  };
  // C1 as P09bb's `compensate` will make it: the exact revision's CAS to compensating.
  const compensating = jobId => {
    const was = row(jobId), next = { ...was, state: 'compensating', rev: was.rev + 1, compensation: { rev: was.rev + 1, proof: null, evidence: null, cause: null } };
    internals.db.prepare('UPDATE kit_context_admissions SET state = ?, rev = ?, record = ? WHERE jobId = ? AND rev = ?').run(next.state, next.rev, JSON.stringify(next), jobId, was.rev);
  };
  function cut(at, when) {
    const db = internals.db, exec = db.exec.bind(db); let armed = true;
    db.exec = sql => {
      if (armed && sql === 'COMMIT' && when()) { armed = false; if (at === 'after-commit') exec(sql); throw new Error('cut-' + at); }
      return exec(sql);
    };
  }
  // A process kill at the next commit for which `when()` holds, just after it or just before it: the handle closes and nothing else is written.
  function kill(when, at = 'after-commit') {
    const db = internals.db, exec = db.exec.bind(db);
    db.exec = sql => {
      if (sql === 'COMMIT' && when()) { if (at === 'after-commit') exec(sql); control.killed = true; db.close(); throw new Error('killed'); }
      return exec(sql);
    };
  }
  return { directory, holds, calls, wire, control, options, prepare, reserveWire, legacyStart, row, compensating, cut, kill, reopen, wireEnds: wire.ends, evidenceOf,
    get store() { return store; }, get admission() { return admission; }, get internals() { return internals; }, get db() { return internals.db; },
    get policy() { return options.policy ?? defaultPolicy; }, changes: () => internals.db.prepare('SELECT total_changes() AS n').get().n };
}
// The live-begin registry is closure-private (the sweep of P09bb reads it from inside the module); the shipped module hands the same reader
// of one transaction instance to this package's tests through `admissionTransactionInternals`, and not through the transaction's API.
const owned = (w, jobId, rev) => admissionTransactionInternals(w.admission).ownedIntent(jobId, rev);
// A policy whose `reserve` for a gated job waits on that job's barrier (and answers its value, default a granted hold).
function gatedPolicy(w) {
  const gates = new Map();
  w.options.policy = { reserve: async request => { w.calls.reserve++; const gate = gates.get(request.jobId); if (gate) { gate.entered.resolve(); return gate.barrier.promise; } return null; },
    release: async () => { w.calls.release++; } };
  return jobId => { const gate = { entered: deferred(), barrier: deferred() }; gates.set(jobId, gate); return gate; };
}
const reject = (promise, code, status) => assert.rejects(promise, { code, ...(status ? { status } : {}) });
async function running(w, p) { await w.admission.begin(p.input); return w.admission.reserveContext(p.input.jobId, w.reserveWire); }
const openHolds = path => parsePolicyLedger(readFileSync(path, 'utf8')).rows.filter(entry => entry.contextHold && !entry.released).length;

test('P09b-T02 a start exactly one hour old is outside the rolling count; one millisecond younger is inside', async t => {
  // Issuance refuses inside the window too, so the challenges are issued first; three starts at T0 fill the limit of three.
  const w = world(t, { contextStartLimits: { maxStartsPerHour: 3, maxStartsPerBuyerPerHour: 3 } });
  const first = w.prepare(0x11), inside = w.prepare(0x22), outside = w.prepare(0x33);
  await w.admission.begin(first.input); w.legacyStart(0x44); w.legacyStart(0x55);
  w.control.clock = T0 + HOUR - 1; await reject(w.admission.begin(inside.input), 'unpaid_start_limit', 429);
  w.control.clock = T0 + HOUR; await w.admission.begin(outside.input);
  assert.equal(w.calls.reserve, 2); assert.equal(w.row(outside.input.jobId).admittedAt, T0 + HOUR);
});

test('P09b-T10 two continuations racing on one revision cannot both act on it', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input);
  const barrier = deferred(), entered = deferred();
  const first = w.admission.reserveContext(p.input.jobId, async () => { entered.resolve(); await barrier.promise; return w.reserveWire(); });
  await entered.promise;
  const second = w.admission.reserveContext(p.input.jobId, w.reserveWire); barrier.resolve();
  const capability = await first, successor = await second;
  assert.equal(w.calls.wire, 2); assert.equal(successor.attempt, capability.attempt + 1);
  assert.equal(w.admission.runningCheck(p.input.jobId, capability.attempt, capability.rev), false);
  assert.equal(w.admission.runningCheck(p.input.jobId, successor.attempt, successor.rev), true);
  await reject(capability.complete(outcome), 'context_admission_closed', 409);
  assert.equal(w.calls.complete.length, 0); assert.equal(w.calls.reserve, 1);
});

test("P09b-T11 C1 against D5's CAS has exactly one winner; a late reservation ends null with zero Vet writes", async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input);
  const barrier = deferred(), entered = deferred();
  const reservation = w.admission.reserveContext(p.input.jobId, async () => { entered.resolve(); await barrier.promise; return w.reserveWire(); });
  await entered.promise; w.compensating(p.input.jobId); barrier.resolve();
  await reject(reservation, 'context_admission_closed', 409);
  assert.equal(w.row(p.input.jobId).state, 'compensating'); assert.equal(w.row(p.input.jobId).attempt, null);
  assert.equal(w.calls.vet, 0); assert.equal(w.calls.complete.length, 1); assert.equal(w.calls.complete[0].outcome, null);
});

test('P09b-T19 two identical attempts in parallel give one validation, one hold and one start', async t => {
  const w = world(t), p = w.prepare(), barrier = deferred(), entered = deferred();
  w.control.beforeReserve = () => { entered.resolve(); return barrier.promise; };
  const start = w.admission.begin(p.input); await entered.promise;
  assert.equal(w.store.challenges.attempt(p.attempt).code, 'context_attempt_pending');
  const duplicate = w.admission.begin(p.input); await reject(duplicate, 'context_job_closed', 409);
  barrier.resolve(null); await start;
  assert.equal(w.calls.validation, 1); assert.equal(w.calls.reserve, 1);
  assert.equal(w.internals.admissionCounts().starts, 1);
});

test('P09b-T25 an accepted admission continues past the freshness limits with zero ledger writes; a missing retained admission answers `session_admission_unavailable`', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input);
  w.control.clock = T0 + 600001; w.control.ready = false; const before = w.changes();
  assert.equal(w.store.challenges.attempt(p.attempt).kind, 'continuation'); assert.equal(w.changes(), before);
  assert.ok(await w.admission.reserveContext(p.input.jobId, w.reserveWire));
  w.db.prepare('UPDATE kit_challenges SET accepted = NULL WHERE nonce = ?').run(p.input.nonce);
  const after = w.changes(); assert.equal(w.store.challenges.attempt(p.attempt).code, 'session_admission_unavailable');
  assert.equal(w.changes(), after); assert.equal(w.calls.reserve, 1);
});

test('P09b-T26 context-record capacity filling after D1: D2 creates no intent, hold, allocation, accounting row or journal file, and only the owning challenge changes, to `failed{peer_context_capacity}`; the identical retry answers that cause and runs no validation', async t => {
  const w = world(t, { maxContextRecords: 1 }), p = w.prepare(), filler = w.prepare(0x22, OTHER);
  await w.admission.begin(filler.input); const before = w.changes(), validations = w.calls.validation;
  await reject(w.admission.begin(p.input), 'peer_context_capacity', 503);
  assert.equal(w.changes() - before, 1); assert.equal(w.row(p.input.jobId), null);
  assert.equal(w.store.challenges.retained(p.input.nonce).failure.code, 'peer_context_capacity');
  assert.deepEqual(w.store.challenges.attempt(p.attempt), { kind: 'refused', code: 'context_challenge_failed', status: 409, cause: 'peer_context_capacity' });
  assert.equal(w.calls.validation, validations); assert.equal(w.calls.reserve, 1); assert.equal(w.calls.wire, 0);
});

test('P09b-T27 an ordinary admission makes exactly one validation, hold and start, and leaves no open hold after settlement', async t => {
  const w = world(t), p = w.prepare(), capability = await running(w, p);
  w.calls.vet += 2; await capability.complete(outcome);
  assert.equal(w.calls.validation, 1); assert.equal(w.calls.reserve, 1); assert.equal(w.calls.vet, 2);
  assert.equal(w.calls.complete.length, 1); assert.strictEqual(w.calls.complete[0].effect, capability.effect); assert.strictEqual(w.calls.complete[0].outcome, outcome);
  assert.equal(w.holds.size, 0); assert.equal(w.internals.admissionCounts().starts, 1);
  const settled = w.row(p.input.jobId);
  assert.equal(settled.state, 'settled'); assert.equal(settled.contextOutcome, 'other', 'the fixture is no exact present context');
  assert.deepEqual(settled.cleanup, { releasePending: false, holdCall: 'settled', cause: null, tries: 0 });
});

test('P09b-T28 on the real policy ledger, the job mutex makes release-then-reserve impossible through the module; the hold time bound holds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world(t), evidencePath = join(w.directory, 'policy.jsonl');
  const real = createSellerContextAdmission({ evidencePath, sellerApproval: { mode: 'policy' }, now: () => T0 });
  const entered = deferred(), barrier = deferred(), finished = deferred();
  w.options.policy = { reserve: async request => { await real.reserve(request); entered.resolve(); await barrier.promise; return null; },
    release: async request => { await real.release(request); finished.resolve(); } };
  w.reopen(); const p = w.prepare(), start = w.admission.begin(p.input);
  const rejected = reject(start, 'seller_budget_unavailable', 503); await entered.promise;
  let acquired = false;
  const queued = w.admission.jobEffectMutex(p.input.jobId).run(() => { acquired = true; });
  t.mock.timers.tick(POLICY_MS - 1); await Promise.resolve(); assert.equal(acquired, false);
  t.mock.timers.tick(1); await rejected; assert.equal(acquired, false);
  assert.equal(w.row(p.input.jobId).cleanup.holdCall, 'pending'); assert.equal(openHolds(evidencePath), 1);
  barrier.resolve(); await finished.promise; await queued;
  assert.equal(openHolds(evidencePath), 0); assert.equal(acquired, true);
  const edgePath = join(w.directory, 'edge.jsonl'); let clock = Number.MAX_SAFE_INTEGER;
  const edge = createSellerContextAdmission({ evidencePath: edgePath, sellerApproval: { mode: 'policy' }, now: () => clock });
  const request = { jobId: p.input.jobId, effect: hash('edge-effect'), writes: 2, hold: 'edge' };
  assert.equal(await edge.reserve(request), null); await edge.release({ jobId: p.input.jobId, hold: 'edge' });
  assert.equal(await edge.reserve(request), 'hold-released');
  clock = Number.MAX_SAFE_INTEGER + 1; await assert.rejects(edge.reserve({ ...request, hold: 'unsafe-time' }), RangeError);
  const order = createSellerContextAdmission({ evidencePath: join(w.directory, 'order.jsonl'), sellerApproval: { mode: 'policy' }, now: () => T0 });
  const lateRelease = releaseSellerContextHolds({ evidencePath: join(w.directory, 'order.jsonl'), jobId: p.input.jobId, holdId: 'release-first', now: () => T0 });
  const lateReserve = order.reserve({ ...request, hold: 'release-first' });
  assert.deepEqual(await Promise.all([lateRelease, lateReserve]), [[], null]);
});

test('P09b-T29 the running check is true only for the running attempt and revision, and false after compensation', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input);
  assert.equal(w.admission.runningCheck(p.input.jobId, 1, 2), false);
  const capability = await w.admission.reserveContext(p.input.jobId, w.reserveWire), { attempt, rev } = capability;
  assert.equal(w.admission.runningCheck(p.input.jobId, attempt + 1, rev), false);
  assert.equal(w.admission.runningCheck(p.input.jobId, attempt, rev + 1), false);
  assert.equal(w.row(p.input.jobId).attemptFence, 'open');
  assert.equal(w.admission.runningCheck(p.input.jobId, attempt, rev), true);
  assert.equal(w.row(p.input.jobId).attemptFence, 'effect-authorized'); assert.equal(w.row(p.input.jobId).rev, rev);
  w.compensating(p.input.jobId); assert.equal(w.admission.runningCheck(p.input.jobId, attempt, rev), false);
  w.reopen(); assert.equal(w.row(p.input.jobId).state, 'compensating');
  assert.equal(w.admission.runningCheck(p.input.jobId, attempt, rev), false);
});

test('P09b-T31 issuance counters see both the old admission rows and the new ones', async t => {
  const w = world(t, { contextStartLimits: { maxStartsPerHour: 3, maxStartsPerBuyerPerHour: 3 } });
  const first = w.prepare(0x11), refused = w.prepare(0x44);
  await w.admission.begin(first.input);
  w.control.beforeReserve = () => 'write-limit'; await reject(w.admission.begin(refused.input), 'seller_budget_refused', 409); w.control.beforeReserve = null;
  assert.equal(w.internals.admissionCounts().starts, 1, 'an intent that never admitted is not a start');
  w.legacyStart(0x22); w.legacyStart(0x77);
  // One kit start and two old ones reach three together: neither table alone does.
  assert.throws(() => w.prepare(0x33), { code: 'unpaid_start_limit' });
  const counts = w.internals.admissionCounts();
  assert.equal(counts.starts, 3); assert.equal(counts.buyerStarts(BUYER), 3); assert.equal(counts.contextRecords, 4);
  w.compensating(first.input.jobId); assert.equal(w.internals.admissionCounts().starts, 3, 'a compensated start stays counted');
});

test('P09b-T32 an invalid seller clock before D1 answers `peer_clock_invalid` with no ledger access and zero mutations anywhere', async t => {
  const w = world(t), p = w.prepare(), before = w.changes(); let reads = 0;
  const prepare = w.db.prepare.bind(w.db); t.mock.method(w.db, 'prepare', (...args) => { reads++; return prepare(...args); });
  for (const clock of [Number.MAX_SAFE_INTEGER, -1, Number.NaN]) {
    w.control.clock = clock; await reject(w.admission.begin(p.input), 'peer_clock_invalid', 503);
  }
  assert.equal(reads, 0); assert.equal(w.changes(), before); assert.equal(w.calls.reserve, 0);
});

test('admission-D2-refusal-table', async t => {
  const scenarios = [
    ['context_job_closed', 409, {}, async (w, p) => { await w.admission.begin(p.input); }, false],
    ['seller_not_ready', 503, {}, (w) => { w.control.ready = false; }, true],
    ['seller_not_ready', 503, { capacity: { fitsNewPurchase: () => false, allocateWithin() {} } }, () => {}, true],
    ['unpaid_start_limit', 429, { contextStartLimits: { maxStartsPerHour: 2, maxStartsPerBuyerPerHour: 5 } }, async (w) => { await w.admission.begin(w.prepare(0x22, OTHER).input); w.legacyStart(0x33, OTHER); }, true],
    ['buyer_unpaid_start_limit', 429, { contextStartLimits: { maxStartsPerHour: 12, maxStartsPerBuyerPerHour: 2 } }, async (w) => { await w.admission.begin(w.prepare(0x22).input); w.legacyStart(0x33); }, true],
    ['context_challenge_attempt_invalid', 409, {}, (w, p) => { w.store.challenges.recordFailed(p.input.owner, p.input.nonce, 'validator_lost'); }, false],
  ];
  for (const [code, status, config, arrange, failsChallenge] of scenarios) {
    const w = world(t, config), p = w.prepare(); await arrange(w, p);
    const reserves = w.calls.reserve, was = w.row(p.input.jobId);
    await reject(w.admission.begin(p.input), code, status);
    assert.equal(w.calls.reserve, reserves, code); assert.deepEqual(w.row(p.input.jobId), was, code); assert.equal(w.calls.wire, 0, code);
    if (failsChallenge) assert.equal(w.store.challenges.retained(p.input.nonce).failure.code, code);
  }
});

test('admission-intent-before-policy-restart', async t => {
  const w = world(t), p = w.prepare(); w.cut('after-commit', () => w.row(p.input.jobId)?.state === 'intent');
  await assert.rejects(w.admission.begin(p.input), Error);
  const saved = w.row(p.input.jobId); assert.equal(saved.state, 'intent'); assert.equal(saved.rev, 1); assert.equal(saved.admittedAt, null);
  assert.match(saved.holdId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  w.reopen(); await reject(w.admission.begin(p.input), 'context_job_closed', 409);
  assert.deepEqual(w.row(p.input.jobId), saved); assert.equal(w.calls.reserve, 0); assert.equal(w.internals.admissionCounts().starts, 0);
});

test('admission-policy-pending-before-append-restart', async t => {
  const w = world(t), p = w.prepare(); w.cut('after-commit', () => w.row(p.input.jobId)?.cleanup.holdCall === 'pending');
  await assert.rejects(w.admission.begin(p.input), Error);
  const saved = w.row(p.input.jobId); assert.equal(saved.cleanup.holdCall, 'pending'); assert.equal(w.calls.reserve, 0);
  w.reopen(); assert.deepEqual(w.row(p.input.jobId), saved);
  await reject(w.admission.begin(p.input), 'context_job_closed', 409);
  assert.equal(w.row(p.input.jobId).holdId, saved.holdId); assert.equal(w.calls.reserve, 0); assert.equal(w.holds.size, 0);
});

test('admission-policy-append-lost-ack', async t => {
  const w = world(t), cause = new Error('ack-lost'), evidencePath = join(w.directory, 'lost-ack.jsonl');
  const real = createSellerContextAdmission({ evidencePath, sellerApproval: { mode: 'policy' }, now: () => T0 });
  w.options.policy = { reserve: async request => { await real.reserve(request); throw cause; }, release: request => real.release(request) };
  w.reopen(); const p = w.prepare();
  await assert.rejects(w.admission.begin(p.input), error => error.code === 'seller_budget_unavailable' && error.status === 503 && error.cause === cause);
  await w.admission.jobEffectMutex(p.input.jobId).run(() => {});
  assert.equal(w.row(p.input.jobId).state, 'aborted'); assert.equal(openHolds(evidencePath), 0);
  assert.equal(w.row(p.input.jobId).cleanup.releasePending, false); assert.equal(w.row(p.input.jobId).admittedAt, null);
  w.reopen(); assert.equal(w.row(p.input.jobId).cleanup.holdCall, 'settled');
  assert.equal(w.store.challenges.retained(p.input.nonce).failure.code, 'seller_budget_unavailable');
});

test('admission-D4-atomic-hook-cuts', async t => {
  const order = [], capacity = { fitsNewPurchase: () => true, allocateWithin: purchase => { order.push('capacity'); assert.deepEqual(purchase, { jobId: purchase.jobId, buyer: BUYER, seller: SELLER, listingPin: PIN }); } };
  const refused = world(t, { capacity }), p = refused.prepare(), db = refused.db;
  db.exec('CREATE TABLE test_acceptance (jobId TEXT PRIMARY KEY)');
  refused.admission.addAcceptanceHook(input => { order.push('first'); db.prepare('INSERT INTO test_acceptance VALUES (?)').run(input.jobId); });
  refused.admission.addAcceptanceHook(() => { order.push('second'); throw Object.assign(new Error('hook-full'), { code: 'peer_store_capacity', status: 503 }); });
  await reject(refused.admission.begin(p.input), 'peer_store_capacity', 503);
  assert.deepEqual(order, ['capacity', 'first', 'second']); assert.equal(db.prepare('SELECT count(*) AS n FROM test_acceptance').get().n, 0);
  await drained(refused, p.input.jobId); refused.reopen(); assert.equal(refused.row(p.input.jobId).state, 'aborted'); assert.equal(refused.row(p.input.jobId).admittedAt, null);
  assert.equal(refused.store.challenges.retained(p.input.nonce).state, 'failed'); assert.equal(refused.holds.size, 0); assert.equal(refused.calls.effective, 1);
  assert.equal(refused.internals.admissionCounts().starts, 0);
  for (const at of ['before-commit', 'after-commit']) {
    const w = world(t), q = w.prepare(); w.db.exec('CREATE TABLE test_acceptance (jobId TEXT PRIMARY KEY)');
    w.admission.addAcceptanceHook(input => { w.db.prepare('INSERT INTO test_acceptance VALUES (?)').run(input.jobId); });
    w.cut(at, () => w.row(q.input.jobId)?.state === 'admitted');
    await assert.rejects(w.admission.begin(q.input), Error); w.reopen();
    const committed = at === 'after-commit';
    assert.equal(w.store.challenges.retained(q.input.nonce).state, committed ? 'accepted' : 'failed');
    assert.equal(w.row(q.input.jobId).admittedAt, committed ? T0 : null);
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM test_acceptance').get().n, Number(committed));
    assert.equal(w.internals.admissionCounts().starts, Number(committed)); assert.equal(w.calls.reserve, 1);
  }
});

test('admission-admitted-before-wire-restart', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input); const saved = w.row(p.input.jobId);
  w.reopen(); w.control.clock = T0 + 600001; w.control.ready = false;
  assert.equal(w.store.challenges.attempt(p.attempt).kind, 'continuation');
  const capability = await w.admission.reserveContext(p.input.jobId, w.reserveWire);
  assert.equal(w.row(p.input.jobId).holdId, saved.holdId); assert.equal(w.row(p.input.jobId).admittedAt, T0);
  assert.equal(w.calls.reserve, 1); assert.equal(capability.attempt, 0); assert.equal(w.internals.admissionCounts().starts, 1);
});

test('admission-wire-reserved-before-running-cas', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input);
  w.cut('before-commit', () => w.row(p.input.jobId).state === 'running');
  await assert.rejects(w.admission.reserveContext(p.input.jobId, w.reserveWire), /cut-before-commit/);
  assert.equal(w.calls.wire, 1); assert.equal(w.calls.complete.length, 0); w.reopen();
  assert.equal(w.row(p.input.jobId).state, 'admitted');
  await reject(w.admission.reserveContext(p.input.jobId, async () => { throw Object.assign(new Error('lease-live'), { code: 'seller_effect_pending' }); }), 'seller_effect_pending');
  assert.equal(w.row(p.input.jobId).state, 'admitted');
  const recovered = await w.admission.reserveContext(p.input.jobId, w.reserveWire);
  assert.equal(recovered.attempt, 1); assert.equal(recovered.effect.state, 'recover');
  assert.equal(w.calls.reserve, 1); assert.equal(w.calls.vet, 0);
});

test('admission-D5-mismatch', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input);
  const done = { state: 'completed', operationId: hash('wire-operation'), outcome };
  assert.strictEqual(await w.admission.reserveContext(p.input.jobId, async () => done), done);
  assert.equal(w.row(p.input.jobId).state, 'admitted'); assert.equal(w.row(p.input.jobId).attempt, null);
  await reject(w.admission.reserveContext(p.input.jobId, async () => { throw Object.assign(new Error('other-presentation'), { code: 'seller_effect_pending', status: 503 }); }), 'seller_effect_pending', 503);
  assert.equal(w.row(p.input.jobId).state, 'admitted');
  await reject(w.admission.reserveContext(p.input.jobId, async () => { throw Object.assign(new Error('different-body'), { code: 'peer_operation_mismatch', status: 409 }); }), 'peer_operation_mismatch', 409);
  const fenced = w.row(p.input.jobId);
  assert.equal(fenced.state, 'compensating'); assert.equal(fenced.compensation.rev, fenced.rev); assert.equal(fenced.compensation.cause.code, 'peer_operation_mismatch');
  assert.equal(w.calls.vet, 0); assert.equal(w.calls.release, 0);
  await reject(w.admission.reserveContext(p.input.jobId, w.reserveWire), 'context_admission_closed', 409);
});

test('admission-completion-publication-fence', async t => {
  const w = world(t), p = w.prepare(), capability = await running(w, p), barrier = deferred(), entered = deferred();
  const occupied = w.admission.jobEffectMutex(p.input.jobId).run(async () => { entered.resolve(); await barrier.promise; }); await entered.promise;
  const completion = capability.complete(outcome); w.compensating(p.input.jobId); barrier.resolve(); await occupied;
  await reject(completion, 'context_admission_closed', 409);
  assert.equal(w.calls.complete.length, 0); assert.equal(w.calls.release, 0); assert.equal(w.row(p.input.jobId).state, 'compensating');
  assert.equal(w.holds.size, 1); assert.equal(w.row(p.input.jobId).contextOutcome, null);
});

test('admission-D7-before-settlement-restart', async t => {
  const w = world(t), p = w.prepare(), capability = await running(w, p);
  w.cut('before-commit', () => w.row(p.input.jobId).state === 'settled');
  await assert.rejects(capability.complete(outcome), /cut-before-commit/);
  assert.equal(w.row(p.input.jobId).state, 'running'); assert.deepEqual(w.wireEnds.get(capability.attempt), outcome);
  assert.equal(w.calls.release, 0); assert.equal(w.calls.vet, 0);
  await reject(capability.complete(null), 'seller_effect_conflict');
  assert.deepEqual(w.wireEnds.get(capability.attempt), outcome, 'a null end never replaces the published outcome');
  w.reopen(); assert.equal(w.row(p.input.jobId).state, 'running'); assert.deepEqual(w.wireEnds.get(capability.attempt), outcome);
  const retry = world(t), q = retry.prepare(), again = await running(retry, q);
  retry.cut('before-commit', () => retry.row(q.input.jobId).state === 'settled');
  await assert.rejects(again.complete(outcome), /cut-before-commit/);
  await again.complete(outcome);
  assert.equal(retry.row(q.input.jobId).state, 'settled'); assert.equal(retry.calls.release, 1); assert.equal(retry.holds.size, 0);
});

test('admission-hook-thenable-and-store-fault', async t => {
  const unhandled = []; const onUnhandled = reason => unhandled.push(reason); process.on('unhandledRejection', onUnhandled); t.after(() => process.off('unhandledRejection', onUnhandled));
  const w = world(t), p = w.prepare(); w.admission.addAcceptanceHook(() => Promise.reject(new Error('late-refusal')));
  await assert.rejects(w.admission.begin(p.input), TypeError); await flush();
  await drained(w, p.input.jobId);
  assert.deepEqual(unhandled, []); assert.equal(w.row(p.input.jobId).state, 'aborted'); assert.equal(w.row(p.input.jobId).admittedAt, null);
  assert.equal(w.store.challenges.retained(p.input.nonce).failure.code, 'operation_uncertain'); assert.equal(w.holds.size, 0);
  const faulty = world(t), q = faulty.prepare(); faulty.cut('before-commit', () => faulty.row(q.input.jobId)?.state === 'admitted');
  await assert.rejects(faulty.admission.begin(q.input), /cut-before-commit/); await drained(faulty, q.input.jobId);
  assert.equal(faulty.row(q.input.jobId).state, 'aborted'); assert.equal(faulty.holds.size, 0); assert.equal(faulty.calls.effective, 1);
  const refused = world(t), r = refused.prepare(), capability = await running(refused, r); refused.wire.latest++;
  await reject(capability.complete(outcome), 'seller_effect_superseded');
  assert.equal(refused.row(r.input.jobId).state, 'running'); assert.equal(refused.calls.release, 0); assert.equal(refused.calls.complete.length, 0);
  assert.throws(() => refused.internals.transaction(() => refused.admission.runningCheck(r.input.jobId, capability.attempt, capability.rev)), TypeError);
});

test('admission-capability-identity', async t => {
  const w = world(t), p = w.prepare(); const a = await running(w, p);
  assert.deepEqual(Object.keys(w.admission).sort(), ['addAcceptanceHook', 'admissionRecord', 'begin', 'cleanupPending', 'compensate', 'jobEffectMutex', 'reserveContext', 'runningCheck', 'sweep']);
  assert.ok(Object.isFrozen(a)); assert.ok(Object.isFrozen(w.admission));
  const b = await w.admission.reserveContext(p.input.jobId, w.reserveWire), copied = a.complete;
  await reject(copied(outcome), 'context_admission_closed', 409);
  await assert.rejects(a.complete(outcome, { effect: b.effect }), TypeError);
  assert.equal(w.admission.runningCheck(p.input.jobId, b.attempt, b.rev), true); assert.equal(w.wireEnds.size, 0); assert.equal(w.calls.release, 0);
});

test('admission-null-end-fence', async t => {
  let journal, requests = 0;
  const w = world(t, { completeWire: (effect, answer) => completeWireEffect(journal, effect, answer) });
  const directory = join(w.directory, 'journal'); mkdirSync(directory, { mode: 0o700 });
  journal = openWireRequestJournal(directory, { leaseMs: 1000, clock: () => w.control.clock });
  const reserveReal = input => async () => reserveEffect(journalStore(journal), { key: hash('key' + ++requests), seller: SELLER, jobId: input.jobId, path: SELLER_CONTEXT_PATH,
    binding: wireOperationBinding({ profile: PROFILE, buyer: input.buyer, agreementHash: input.contextScopeHash }), requestHash: hash('request' + requests) });
  const view = input => inspectWireOperation(journal, { seller: SELLER, jobId: input.jobId, path: SELLER_CONTEXT_PATH });
  // (1) null wins before any check: the attempt is fenced, liabilities stay, and only a new D5 can continue.
  const first = w.prepare(0x11); await w.admission.begin(first.input); const a = await w.admission.reserveContext(first.input.jobId, reserveReal(first.input));
  const held = w.row(first.input.jobId); await a.complete(null);
  assert.equal(view(first.input).state, 'ended'); assert.equal(w.row(first.input.jobId).attemptFence, 'null-ended'); assert.equal(w.row(first.input.jobId).rev, held.rev);
  assert.equal(w.admission.runningCheck(first.input.jobId, a.attempt, a.rev), false); assert.equal(w.holds.size, 1); assert.equal(w.calls.release, 0);
  const next = await w.admission.reserveContext(first.input.jobId, reserveReal(first.input));
  assert.equal(next.attempt, a.attempt + 1); assert.equal(w.row(first.input.jobId).attemptFence, 'open'); assert.equal(w.admission.runningCheck(first.input.jobId, next.attempt, next.rev), true);
  // (2) the check authorized first: a later null refuses and publishes no end.
  await reject(next.complete(null), 'context_admission_closed', 409);
  assert.equal(view(first.input).state, 'pending'); assert.equal(w.row(first.input.jobId).attemptFence, 'effect-authorized'); assert.equal(w.calls.release, 0);
  // (3) a successor or C1 first: neither null nor a non-null end publishes.
  w.control.clock += 1001; const successor = await w.admission.reserveContext(first.input.jobId, reserveReal(first.input));
  await reject(next.complete(null), 'context_admission_closed', 409); await reject(next.complete(outcome), 'context_admission_closed', 409);
  w.compensating(first.input.jobId); await reject(successor.complete(null), 'context_admission_closed', 409);
  assert.equal(view(first.input).state, 'pending');
  // (4) a cut between the latch commit and the journal end leaves a fenced running row; recovery wins D5 afterwards.
  const second = w.prepare(0x22); await w.admission.begin(second.input); const b = await w.admission.reserveContext(second.input.jobId, reserveReal(second.input));
  w.cut('after-commit', () => w.row(second.input.jobId).attemptFence === 'null-ended');
  await assert.rejects(b.complete(null), Error);
  assert.equal(view(second.input).state, 'pending'); assert.equal(w.row(second.input.jobId).state, 'running'); assert.equal(w.row(second.input.jobId).attemptFence, 'null-ended');
  assert.equal(w.admission.runningCheck(second.input.jobId, b.attempt, b.rev), false); assert.equal(w.calls.vet, 0);
});

test('admission-completion-with-owned-lease', async t => {
  const w = world(t), p = w.prepare(), other = w.prepare(0x22); const capability = await running(w, p);
  const mutex = w.admission.jobEffectMutex(p.input.jobId), lease = await mutex.acquire();
  const done = promise => Promise.race([promise.then(() => 'done'), new Promise(resolve => setImmediate(() => resolve('blocked')))]);
  assert.equal(await done(capability.complete(outcome, { jobLease: lease })), 'done');
  assert.equal(w.row(p.input.jobId).state, 'settled'); assert.equal(w.row(p.input.jobId).cleanup.releasePending, true); assert.equal(w.calls.release, 0);
  lease.release(); await flush(); lease.release();
  assert.equal(w.calls.release, 1); assert.equal(w.holds.size, 0); assert.equal(w.row(p.input.jobId).cleanup.releasePending, false);
  await w.admission.begin(other.input); const second = await w.admission.reserveContext(other.input.jobId, w.reserveWire);
  const foreign = await mutex.acquire(), released = await w.admission.jobEffectMutex(other.input.jobId).acquire(); released.release();
  const published = w.calls.complete.length;
  for (const jobLease of [{ release() {} }, foreign, released, undefined]) await assert.rejects(second.complete(null, { jobLease }), TypeError);
  assert.equal(w.calls.complete.length, published); foreign.release();
  const third = await w.admission.jobEffectMutex(other.input.jobId).acquire();
  assert.equal(await done(second.complete(null, { jobLease: third })), 'done'); assert.equal(w.row(other.input.jobId).attemptFence, 'null-ended'); third.release();
});

test('admission-acceptance-hook-sealed', async t => {
  const w = world(t), p = w.prepare(); w.admission.addAcceptanceHook(() => {});
  assert.throws(() => w.admission.addAcceptanceHook(null), TypeError);
  w.control.ready = false; await reject(w.admission.begin(p.input), 'seller_not_ready', 503);
  assert.throws(() => w.admission.addAcceptanceHook(() => {}), TypeError);
});

test('admission-caller-admitted-at-refused', async t => {
  const w = world(t), p = w.prepare(), before = w.changes();
  await assert.rejects(w.admission.begin({ ...p.input, accepted: { ...p.input.accepted, admittedAt: T0 } }), TypeError);
  assert.equal(w.changes(), before); assert.equal(w.calls.reserve, 0); assert.equal(w.row(p.input.jobId), null);
});

test('admission-stored-admission-must-name-the-rows-seller-and-listing', async t => {
  const otherPin = { ...PIN, version: 2 }, sellerEntry = admission => admission.participants.find(entry => entry.role === 'seller');
  const variants = {
    'another seller': admission => { sellerEntry(admission).claim = OTHER; },
    'another Listing version': admission => { admission.listingPin = otherPin; },
    'another Listing hash': admission => { admission.listingPin = { ...PIN, contentHash: hash('another-listing') }; },
    'a Listing pin with an extra member': admission => { admission.listingPin = { ...PIN, extra: true }; },
    'no Listing': admission => { delete admission.listingPin; },
    'no seller entry': admission => { admission.participants = admission.participants.filter(entry => entry.role !== 'seller'); },
    'two seller entries': admission => { admission.participants.push(structuredClone(sellerEntry(admission))); },
    'no participants': admission => { delete admission.participants; },
  };
  for (const [name, change] of Object.entries(variants)) {
    const w = world(t), p = w.prepare(), before = w.changes(); change(p.input.accepted.admission);
    await reject(w.admission.begin(p.input), 'context_challenge_attempt_invalid', 409);
    assert.equal(w.row(p.input.jobId), null, name); assert.equal(w.calls.reserve, 0, name); assert.equal(w.changes(), before, name);
    assert.equal(w.store.challenges.retained(p.input.nonce).state, 'attempted', name);
  }
  const w = world(t), p = w.prepare(); p.input.accepted.admission.participants.find(entry => entry.role === 'seller').claim = `${SELLER}?jurisdiction=GB`;
  await w.admission.begin(p.input); assert.equal(w.store.challenges.retained(p.input.nonce).state, 'accepted');
});

test('admission-continuation-retains-envelope-parties', async t => {
  const w = world(t), p = w.prepare(0x11, BUYER, { presenter: EQUIVALENT_BUYER });
  await reject(w.admission.begin({ ...p.input, sellerBundlePresentedBy: undefined }), 'context_challenge_attempt_invalid', 409);
  assert.equal(w.row(p.input.jobId), null); assert.equal(w.store.challenges.retained(p.input.nonce).state, 'attempted');
  await w.admission.begin(p.input); const saved = w.row(p.input.jobId);
  assert.equal(saved.buyer, BUYER); assert.equal(saved.seller, SELLER);
  assert.deepEqual(saved.vetPresenters, { buyer: EQUIVALENT_BUYER, seller: SELLER });
  assert.deepEqual(saved.vetAddresses, { buyer: compositeVerificationAddress(p.input.jobId, EQUIVALENT_BUYER), seller: compositeVerificationAddress(p.input.jobId, SELLER) });
  assert.equal(saved.contextBinding, wireOperationBinding({ profile: PROFILE, buyer: BUYER, agreementHash: p.input.contextScopeHash }));
  assert.deepEqual(w.control.reserved, [{ jobId: p.input.jobId, effect: wireOperationId({ seller: SELLER, jobId: p.input.jobId, path: SELLER_CONTEXT_PATH }), writes: 2, hold: saved.holdId }]);
  await reject(w.admission.begin({ ...p.input, buyer: EQUIVALENT_BUYER }), 'peer_job_conflict', 409);
  assert.equal(w.row(p.input.jobId).buyer, BUYER); assert.equal(w.calls.reserve, 1);
});

test('admission-request-is-detached-from-the-caller', async t => {
  const w = world(t), p = w.prepare(), savedText = p.input.accepted.buyerBundleText, entered = deferred(), barrier = deferred();
  w.control.beforeReserve = () => { entered.resolve(); return barrier.promise; };
  const start = w.admission.begin(p.input); await entered.promise;
  p.input.accepted.buyerBundleText = '{}'; p.input.seller = OTHER; barrier.resolve(null); await start;
  assert.equal(w.store.challenges.retained(p.input.nonce).accepted.buyerBundleText, savedText);
  assert.equal(w.row(p.input.jobId).seller, SELLER);
});

test('admission-reserve-acquisition-deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input);
  const barrier = deferred(), entered = deferred();
  const occupied = w.admission.jobEffectMutex(p.input.jobId).run(async () => { entered.resolve(); await barrier.promise; }); await entered.promise;
  const pending = w.admission.reserveContext(p.input.jobId, w.reserveWire); const rejected = reject(pending, 'seller_effect_pending', 503);
  t.mock.timers.tick(POLICY_MS); await rejected; assert.equal(w.calls.wire, 0);
  barrier.resolve(); await occupied; await flush();
  const reacquired = w.admission.jobEffectMutex(p.input.jobId).acquire().then(lease => { lease.release(); return 'free'; });
  assert.equal(await Promise.race([reacquired, new Promise(resolve => setImmediate(() => resolve('held by the late lease')))]), 'free');
  assert.equal(w.row(p.input.jobId).state, 'admitted'); assert.equal(w.calls.wire, 0);
});

test('admission-release-failure-keeps-the-settlement-and-its-cause', async t => {
  const w = world(t), p = w.prepare(), capability = await running(w, p), cause = new Error('release-ack-lost');
  w.control.releaseFault = cause; await capability.complete(outcome);
  const settled = w.row(p.input.jobId);
  assert.equal(settled.state, 'settled'); assert.equal(settled.cleanup.releasePending, true); assert.equal(settled.cleanup.tries, 1);
  assert.equal(settled.cleanup.cause.message, 'release-ack-lost'); assert.equal(w.calls.complete.length, 1);
});

// ---- P09bb: compensation C2-C4, the outcome classifier, durable release, the sweep and the admission record ----
const drained = (w, jobId) => w.admission.jobEffectMutex(jobId).run(() => {});
const sweepTwice = async (w, startup = false) => { await w.admission.sweep({ startup }); await w.admission.sweep({ startup: false }); };
const restart = async w => { w.reopen(); await sweepTwice(w, true); };
const failedWith = (w, p, code) => assert.equal(w.store.challenges.retained(p.input.nonce).failure.code, code);
// A row that is running whose context outcome is durable in the wire but not yet settled: the cut falls between D7 and D8a.
async function crashAfterPublish(w, p, answer) {
  const capability = await running(w, p);
  w.cut('before-commit', () => w.row(p.input.jobId).state === 'settled');
  await assert.rejects(capability.complete(answer), /cut-before-commit/);
  assert.equal(w.row(p.input.jobId).state, 'running');
  return capability;
}
const COMPLETED_CLASSES = [['success', jobId => presented(jobId)], ['vet-non-pass', () => nonPass], ['other', () => ({ status: 200, text: '{"disposition":"indeterminate"}' })],
  ['other', jobId => ({ ...presented(jobId), status: 503 })]];
const ENVELOPE = JSON.stringify({ error: 'party_vet_non_pass', message: 'buyer Vet decision: fail' });
const presentedWith = (jobId, extra, inValue = false) => {
  const { value, ...rest } = JSON.parse(presented(jobId).text);
  return { status: 200, text: JSON.stringify(inValue ? { ...rest, value: { ...value, ...extra } } : { ...rest, value, ...extra }) };
};
const OTHER_OUTCOMES = [
  ['a present answer for another scope', jobId => presented(jobId, {}, { agreement: 'another' })],
  ['a present answer for another job', () => presented(job(0x99))],
  ['a present answer without the buyer record', jobId => presented(jobId, { buyer: {} })],
  ['a present answer without the seller record', jobId => presented(jobId, { seller: { vetRecordRef: null } })],
  ['a present answer whose two references are empty objects', jobId => presented(jobId, { buyer: { vetRecordRef: {} }, seller: { vetRecordRef: {} } })],
  ['a present answer whose buyer reference is empty', jobId => presented(jobId, { buyer: { vetRecordRef: {} } })],
  ['a present answer whose references lack an anchor', jobId => presented(jobId, { buyer: { vetRecordRef: { contentHash: hash('buyer') } }, seller: { vetRecordRef: { contentHash: hash('seller') } } })],
  ['a present answer whose seller reference has an unknown anchor kind', jobId => presented(jobId, { seller: { vetRecordRef: { anchor: { kind: 'elsewhere', locator: 'x' }, contentHash: hash('seller') } } })],
  ['a present answer whose buyer reference has a malformed content hash', jobId => presented(jobId, { buyer: { vetRecordRef: { anchor: { kind: 'https', locator: 'x' }, contentHash: 'not-a-hash' } } })],
  ['a present answer whose seller reference carries an extra key', jobId => presented(jobId, { seller: { vetRecordRef: { ...vetRef('seller').vetRecordRef, extra: true } } })],
  ['a present answer whose buyer reference names a malformed signer', jobId => presented(jobId, { buyer: { vetRecordRef: { ...vetRef('buyer').vetRecordRef, signer: 'not-a-claim' } } })],
  ['an absent answer', () => ({ status: 200, text: '{"disposition":"absent"}' })],
  ['a rejection that is not a Vet non-pass', () => ({ status: 409, text: '{"disposition":"rejected","code":"other_refusal"}' })],
  ['text that is not JSON', () => ({ status: 200, text: 'not json' })],
  ['a JSON array', () => ({ status: 200, text: '[]' })],
  ['a JSON scalar', () => ({ status: 200, text: '7' })],
  ['JSON null', () => ({ status: 200, text: 'null' })],
  // The buyer reads a stored response by its status first: a valid body at another status is not the answer the body says.
  ...[409, 201, 503, '200', undefined].map(status => [`a valid present answer stored with status ${String(status)}`, jobId => ({ ...presented(jobId), status })]),
  ...[409, 503].map(status => [`a Vet non-pass rejection stored with status ${status}`, () => ({ ...nonPass, status })]),
  ...[200, 503, 429, 408].map(status => [`the Vet non-pass error envelope stored with status ${status}`, () => ({ status, text: ENVELOPE })]),
  ['a present answer with an extra top-level key', jobId => presentedWith(jobId, { extra: true })],
  ['a present answer whose value has an extra key', jobId => presentedWith(jobId, { extra: true }, true)],
  ['an indeterminate answer that carries the Vet non-pass error', () => ({ status: 200, text: '{"disposition":"indeterminate","error":"party_vet_non_pass"}' })],
  ['an absent answer that carries the Vet non-pass error', () => ({ status: 422, text: '{"disposition":"absent","error":"party_vet_non_pass"}' })],
  ['a refusal envelope with another error', () => ({ status: 422, text: '{"error":"other_refusal"}' })],
];
// The Vet non-pass error envelope of the statuses the buyer reads as a refusal, at both ends of the range.
const ENVELOPE_NON_PASS = [409, 422, 400, 499].map(status => ['vet-non-pass', () => ({ status, text: ENVELOPE }), `the Vet non-pass error envelope stored with status ${status}`]);

test('P09b-T01 at 12 counted starts, D4 compensates to aborted, releases the hold and fails the challenge with `unpaid_start_limit`', async t => {
  const w = world(t, { contextStartLimits: { maxStartsPerHour: 12, maxStartsPerBuyerPerHour: 12 } }), p = w.prepare();
  for (let index = 0; index < 11; index++) w.legacyStart(0x40 + index, OTHER);
  w.control.beforeReserve = () => { w.legacyStart(0x60, OTHER); return null; };
  await reject(w.admission.begin(p.input), 'unpaid_start_limit', 429); await drained(w, p.input.jobId);
  const aborted = w.row(p.input.jobId);
  assert.equal(aborted.state, 'aborted'); assert.equal(aborted.admittedAt, null); assert.equal(aborted.compensation.proof, 'no-effect'); assert.equal(aborted.cleanup.releasePending, false);
  assert.equal(w.holds.size, 0); assert.equal(w.calls.effective, 1); failedWith(w, p, 'unpaid_start_limit'); assert.equal(w.internals.admissionCounts().starts, 12);
});

test('P09b-T03 compensated admissions count and aborted intents do not, the same after restart', async t => {
  const w = world(t), admitted = w.prepare(0x11), refused = w.prepare(0x22);
  await w.admission.begin(admitted.input); await w.admission.compensate(admitted.input.jobId, 'd');
  w.control.beforeReserve = () => 'budget-refused';
  await reject(w.admission.begin(refused.input), 'seller_budget_refused', 409); await drained(w, refused.input.jobId);
  assert.equal(w.row(admitted.input.jobId).state, 'aborted'); assert.equal(w.row(refused.input.jobId).state, 'aborted');
  assert.equal(w.internals.admissionCounts().starts, 1); w.reopen(); assert.equal(w.internals.admissionCounts().starts, 1);
});

test('P09b-T08 a policy refusal aborts the intent and fails the challenge with `seller_budget_refused`', async t => {
  const w = world(t), p = w.prepare(); w.control.beforeReserve = () => 'budget-refused';
  await reject(w.admission.begin(p.input), 'seller_budget_refused', 409); await drained(w, p.input.jobId);
  assert.equal(w.row(p.input.jobId).state, 'aborted'); assert.equal(w.row(p.input.jobId).admittedAt, null); failedWith(w, p, 'seller_budget_refused');
  assert.equal(w.holds.size, 0); assert.equal(w.admission.cleanupPending(), false); assert.equal(w.internals.admissionCounts().starts, 0);
});

test('P09b-T09 a policy call past 10,000 ms answers `seller_budget_unavailable` and its late hold is released once it settles', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world(t), p = w.prepare(), barrier = deferred(), entered = deferred();
  w.control.beforeReserve = () => { entered.resolve(); return barrier.promise; };
  const start = w.admission.begin(p.input), rejected = assert.rejects(start, error => error.code === 'seller_budget_unavailable' && error.status === 503);
  await entered.promise; t.mock.timers.tick(POLICY_MS); await rejected;
  assert.equal(w.row(p.input.jobId).state, 'compensating'); assert.equal(w.row(p.input.jobId).cleanup.holdCall, 'pending');
  assert.equal(w.admission.cleanupPending(), true); assert.equal(w.holds.size, 1); assert.equal(w.calls.release, 0);
  barrier.resolve(null); await drained(w, p.input.jobId);
  assert.equal(w.row(p.input.jobId).state, 'aborted'); assert.equal(w.holds.size, 0); assert.equal(w.calls.effective, 1); assert.equal(w.admission.cleanupPending(), false);
});

test('P09b-T12 an operator abort before D3 takes the mutex leaves zero policy lines and an aborted row', async t => {
  const w = world(t), p = w.prepare(), entered = deferred(), barrier = deferred();
  const occupied = w.admission.jobEffectMutex(p.input.jobId).run(async () => { entered.resolve(); await barrier.promise; }); await entered.promise;
  const start = w.admission.begin(p.input), closed = reject(start, 'context_admission_closed', 409), abort = w.admission.compensate(p.input.jobId, 'd');
  barrier.resolve(); await occupied; await closed; await abort;
  assert.equal(w.row(p.input.jobId).state, 'aborted'); assert.equal(w.calls.reserve, 0); assert.equal(w.calls.release, 0);
  assert.equal(w.row(p.input.jobId).cleanup.releasePending, false); failedWith(w, p, 'context_admission_closed'); assert.equal(w.admission.cleanupPending(), false);
});

test('P09b-T13 an abort while `reserve()` is inside its append waits for the mutex; the appended hold is released before cleanup reports complete', async t => {
  const w = world(t), p = w.prepare(), entered = deferred(), barrier = deferred();
  w.control.beforeReserve = () => { entered.resolve(); return barrier.promise; };
  const start = w.admission.begin(p.input), closed = reject(start, 'context_admission_closed', 409); await entered.promise;
  const abort = w.admission.compensate(p.input.jobId, 'd'); await flush();
  assert.equal(w.row(p.input.jobId).state, 'compensating'); assert.equal(w.holds.size, 1); assert.equal(w.calls.release, 0); assert.equal(w.admission.cleanupPending(), true);
  barrier.resolve(null); await closed; await abort;
  assert.equal(w.row(p.input.jobId).state, 'aborted'); assert.equal(w.holds.size, 0); assert.equal(w.calls.effective, 1); assert.equal(w.admission.cleanupPending(), false);
});

test('P09b-T14 the T12 and T13 cases with a restart at and after the barrier end with no open hold on an aborted row', async t => {
  const marked = world(t), first = marked.prepare();   // killed as D3 is marked pending, before the append
  marked.kill(() => marked.row(first.input.jobId)?.cleanup.holdCall === 'pending');
  await assert.rejects(marked.admission.begin(first.input), Error); await restart(marked);
  assert.equal(marked.row(first.input.jobId).state, 'aborted'); assert.equal(marked.calls.reserve, 0); assert.equal(marked.holds.size, 0); assert.equal(marked.admission.cleanupPending(), false);
  const appended = world(t), second = appended.prepare();   // killed with the hold line durable, before D4
  appended.control.beforeReserve = () => { appended.control.killed = true; appended.db.close(); return null; };
  await assert.rejects(appended.admission.begin(second.input), Error); assert.equal(appended.holds.size, 1); appended.control.beforeReserve = null;
  await restart(appended);
  assert.equal(appended.row(second.input.jobId).state, 'aborted'); assert.equal(appended.holds.size, 0); assert.equal(appended.calls.effective, 1); assert.equal(appended.admission.cleanupPending(), false);
  const fenced = world(t), third = fenced.prepare(), entered = deferred(), barrier = deferred();   // an abort's C1 is durable while reserve() is inside its append
  fenced.control.beforeReserve = () => { entered.resolve(); return barrier.promise; };
  const start = assert.rejects(fenced.admission.begin(third.input), Error); await entered.promise;
  fenced.kill(() => fenced.row(third.input.jobId)?.state === 'compensating'); await assert.rejects(fenced.admission.compensate(third.input.jobId, 'd'), Error);
  barrier.resolve(null); await start; fenced.control.beforeReserve = null; await restart(fenced);
  assert.equal(fenced.row(third.input.jobId).state, 'aborted'); assert.equal(fenced.holds.size, 0); assert.equal(fenced.calls.effective, 1);
});

test('P09b-T15 trigger (c) fires at delegation expiry plus 30,000 ms, not one millisecond earlier, and keeps the row on an unsafe sum', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input); const admitted = w.row(p.input.jobId);
  w.control.clock = T0 + HOUR + 29999; await w.admission.compensate(p.input.jobId, 'c'); await sweepTwice(w);
  assert.deepEqual(w.row(p.input.jobId), admitted); assert.equal(w.calls.release, 0);
  w.control.clock = T0 + HOUR + 30000; await w.admission.compensate(p.input.jobId, 'c');
  assert.equal(w.row(p.input.jobId).state, 'aborted'); assert.equal(w.holds.size, 0); assert.equal(w.calls.effective, 1);
  const direct = world(t), q = direct.prepare(0x22); q.input.delegationExpiresAt = null; await direct.admission.begin(q.input);
  direct.control.clock = Number.MAX_SAFE_INTEGER - SESSION_CHALLENGE_LIFETIME_MS; await sweepTwice(direct); await direct.admission.compensate(q.input.jobId, 'c');
  assert.equal(direct.row(q.input.jobId).state, 'admitted'); assert.equal(direct.row(q.input.jobId).cleanup.cause, null);
  const unsafe = world(t), r = unsafe.prepare(0x33); r.input.delegationExpiresAt = Number.MAX_SAFE_INTEGER - 5; await unsafe.admission.begin(r.input);
  await unsafe.admission.compensate(r.input.jobId, 'c');
  assert.equal(unsafe.row(r.input.jobId).state, 'admitted'); assert.equal(unsafe.row(r.input.jobId).cleanup.cause.code, 'peer_clock_invalid');
  assert.equal(unsafe.admission.cleanupPending(), true); assert.equal(unsafe.holds.size, 1); assert.equal(unsafe.calls.release, 0);
});

test('P09b-T16 trigger (c) after a clean null end with no Vet intent aborts as no-effect', async t => {
  const w = world(t), p = w.prepare(), capability = await running(w, p); await capability.complete(null);
  assert.equal(w.row(p.input.jobId).attemptFence, 'null-ended'); assert.equal(w.row(p.input.jobId).state, 'running'); assert.equal(w.holds.size, 1);
  w.control.clock = T0 + HOUR + 30000; await w.admission.compensate(p.input.jobId, 'c');
  const aborted = w.row(p.input.jobId);
  assert.equal(aborted.state, 'aborted'); assert.equal(aborted.compensation.proof, 'no-effect'); assert.deepEqual(aborted.compensation.evidence, w.evidenceOf(aborted, 'no-intent'));
  assert.equal(w.holds.size, 0); assert.equal(w.calls.effective, 1);
});

test('P09b-T17 absence on chain is not proof: a dispatched signed CREATE keeps the row compensating; no intent aborts it; a live lease keeps it', async t => {
  const dispatched = world(t), p = dispatched.prepare(); await running(dispatched, p);
  dispatched.control.evidence = record => [{ address: record.vetAddresses.buyer, kind: 'no-intent' },
    { address: record.vetAddresses.seller, kind: 'undetermined', cause: new Error('signed CREATE dispatched') }];
  await dispatched.admission.compensate(p.input.jobId, 'd'); await restart(dispatched);
  const kept = dispatched.row(p.input.jobId);
  assert.equal(kept.state, 'compensating'); assert.equal(kept.cleanup.cause.code, 'context_compensation_undetermined'); assert.equal(dispatched.holds.size, 1); assert.equal(dispatched.calls.release, 0);
  assert.equal(dispatched.admission.cleanupPending(), true);
  const lease = world(t), q = lease.prepare(); await running(lease, q);
  lease.control.inspect = () => ({ state: 'pending', binding: lease.row(q.input.jobId).contextBinding, attempt: 0, requestHash: hash('request'), leaseUntil: T0 + 1000 });
  lease.control.evidence = record => lease.evidenceOf(record, 'undetermined'); await lease.admission.compensate(q.input.jobId, 'd');
  assert.equal(lease.row(q.input.jobId).state, 'compensating'); assert.equal(lease.holds.size, 1);
  for (const kind of ['executed', 'never-dispatched', 'retired', 'absent-on-chain']) {
    const other = world(t), r = other.prepare(); await running(other, r); other.control.evidence = record => other.evidenceOf(record, kind);
    await other.admission.compensate(r.input.jobId, 'd'); assert.equal(other.row(r.input.jobId).state, 'compensating', kind); assert.equal(other.holds.size, 1, kind);
  }
  const clean = world(t), s = clean.prepare(); await running(clean, s); await clean.admission.compensate(s.input.jobId, 'd');
  assert.equal(clean.row(s.input.jobId).state, 'aborted'); assert.equal(clean.holds.size, 0);
});

test('P09b-T18 indeterminate readback keeps the row compensating with its hold and cause', async t => {
  const w = world(t), p = w.prepare(), cause = new Error('journal unreadable'); await running(w, p);
  w.control.evidence = () => { throw cause; }; await w.admission.compensate(p.input.jobId, 'd'); await sweepTwice(w);
  const kept = w.row(p.input.jobId);
  assert.equal(kept.state, 'compensating'); assert.equal(kept.cleanup.cause.code, 'context_compensation_undetermined'); assert.equal(kept.cleanup.cause.status, 503);
  assert.equal(w.holds.size, 1); assert.equal(w.calls.release, 0); assert.equal(w.admission.cleanupPending(), true);
  w.control.evidence = null; await w.admission.sweep({ startup: false });
  assert.equal(w.row(p.input.jobId).state, 'aborted'); assert.equal(w.row(p.input.jobId).cleanup.cause, null); assert.equal(w.holds.size, 0);
});

test('P09b-T20 identical retries at each barrier are pending; with the owner killed at the barrier they end with zero holds and starts after the sweep', async t => {
  const pending = { kind: 'refused', code: 'context_attempt_pending', status: 503 };
  // Alive: the retry is pending while the owner is validating, waiting for the mutex or inside the policy call; the owner then finishes normally.
  const live = world(t), q = live.prepare(), entered = deferred(), release = deferred(), occupied = deferred();
  assert.deepEqual(live.store.challenges.attempt(q.attempt), pending);
  const held = live.admission.jobEffectMutex(q.input.jobId).run(() => occupied.promise);
  live.control.beforeReserve = () => { entered.resolve(); return release.promise; };
  const start = live.admission.begin(q.input); assert.deepEqual(live.store.challenges.attempt(q.attempt), pending);
  occupied.resolve(); await held; await entered.promise; assert.deepEqual(live.store.challenges.attempt(q.attempt), pending);
  release.resolve(null); await start; assert.equal(live.store.challenges.attempt(q.attempt).kind, 'continuation');
  // Killed: nothing but the challenge, the intent, the pending mark or the hold line is durable; the sweep leaves no hold and no start.
  const barriers = [
    ['validation started', null],
    ['intent committed', (w, p) => w.kill(() => w.row(p.input.jobId)?.state === 'intent')],
    ['policy call marked pending', (w, p) => w.kill(() => w.row(p.input.jobId)?.cleanup.holdCall === 'pending')],
    ['hold line durable', w => { w.control.beforeReserve = () => { w.control.killed = true; w.db.close(); return null; }; }],
  ];
  for (const [barrier, arrange] of barriers) {
    const w = world(t), p = w.prepare();
    if (arrange !== null) { arrange(w, p); await assert.rejects(w.admission.begin(p.input), Error, barrier); }
    w.control.beforeReserve = null; await restart(w);
    assert.deepEqual(w.store.challenges.attempt(p.attempt), { kind: 'refused', code: 'context_challenge_failed', status: 409, cause: 'validator_lost' }, barrier);
    assert.notEqual(w.row(p.input.jobId)?.state ?? 'aborted', 'compensating', barrier); assert.equal(w.holds.size, 0, barrier); assert.equal(w.internals.admissionCounts().starts, 0, barrier);
  }
});

test('P09b-T21 a crash around C1, or after C3 and before C4a, re-reads evidence before aborting, and keeps changed evidence compensating', async t => {
  const c1 = world(t), p = c1.prepare(); await running(c1, p);
  c1.kill(() => c1.row(p.input.jobId).state === 'compensating'); await assert.rejects(c1.admission.compensate(p.input.jobId, 'd'), Error);
  c1.reopen(); assert.equal(c1.row(p.input.jobId).state, 'compensating'); assert.equal(c1.calls.evidence.length, 0);
  c1.control.evidence = record => c1.evidenceOf(record, 'undetermined'); await sweepTwice(c1, true);
  assert.equal(c1.row(p.input.jobId).state, 'compensating'); assert.equal(c1.calls.evidence.length, 2); assert.equal(c1.holds.size, 1);
  c1.control.evidence = null; await c1.admission.sweep({ startup: false });
  assert.equal(c1.row(p.input.jobId).state, 'aborted'); assert.equal(c1.calls.evidence.length, 3); assert.equal(c1.holds.size, 0);
  for (const changed of [false, true]) {
    const w = world(t), q = w.prepare(); await running(w, q);
    w.cut('before-commit', () => w.row(q.input.jobId).state === 'aborted'); await w.admission.compensate(q.input.jobId, 'd');
    const proven = w.row(q.input.jobId);
    assert.equal(proven.state, 'compensating'); assert.equal(proven.compensation.proof, 'no-effect'); assert.equal(w.calls.evidence.length, 1);
    w.reopen(); if (changed) w.control.evidence = record => w.evidenceOf(record, 'undetermined'); await w.admission.sweep({ startup: true });
    assert.equal(w.calls.evidence.length, 2, 'the saved proof is not reused'); assert.equal(w.row(q.input.jobId).state, changed ? 'compensating' : 'aborted');
    assert.equal(w.holds.size, changed ? 1 : 0);
  }
});

test('P09b-T22 lost release acknowledgements are released again idempotently, also across two restarts', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input); w.control.releaseFault = new Error('acknowledgement lost');
  await w.admission.compensate(p.input.jobId, 'd');
  const lost = w.row(p.input.jobId);
  assert.equal(lost.state, 'aborted'); assert.equal(lost.cleanup.releasePending, true); assert.equal(lost.cleanup.tries, 1); assert.equal(w.calls.effective, 1);
  await sweepTwice(w); w.reopen(); await sweepTwice(w, true); w.reopen(); await sweepTwice(w, true);
  assert.equal(w.row(p.input.jobId).cleanup.releasePending, true); assert.equal(w.row(p.input.jobId).cleanup.tries, 7); assert.equal(w.calls.effective, 1);
  assert.equal(w.row(p.input.jobId).rev, lost.rev, 'a retried release is not a state change'); assert.equal(w.admission.cleanupPending(), true);
  w.control.releaseFault = null; await w.admission.sweep({ startup: false });
  assert.equal(w.row(p.input.jobId).cleanup.releasePending, false); assert.equal(w.row(p.input.jobId).cleanup.cause, null); assert.equal(w.calls.effective, 1);
  assert.equal(w.internals.admissionCounts().starts, 1, 'spent starts stay counted'); assert.equal(w.admission.cleanupPending(), false);
});

test('P09b-T23 an unavailable policy ledger keeps `releasePending` with its cause until a later sweep releases', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input); w.control.unavailable = new Error('policy ledger unavailable');
  await w.admission.compensate(p.input.jobId, 'd');
  const waiting = w.row(p.input.jobId);
  assert.equal(waiting.state, 'aborted'); assert.equal(waiting.cleanup.releasePending, true); assert.equal(waiting.cleanup.cause.message, 'policy ledger unavailable');
  assert.equal(w.holds.size, 1); assert.equal(w.admission.cleanupPending(), true);
  await restart(w); assert.equal(w.row(p.input.jobId).cleanup.releasePending, true); assert.equal(w.admission.cleanupPending(), true); assert.equal(w.holds.size, 1);
  w.control.unavailable = null; await w.admission.sweep({ startup: false });
  assert.equal(w.row(p.input.jobId).cleanup.releasePending, false); assert.equal(w.holds.size, 0); assert.equal(w.calls.effective, 1); assert.equal(w.admission.cleanupPending(), false);
});

test('P09b-T23b a release that fails after another release already cleared the row leaves no cause on the settled row; one that fails first is cleared by the later release', async t => {
  for (const order of ['the completion fails after the sweep released', 'the sweep fails before the completion released']) {
    const gate = deferred(), entered = deferred(); let calls = 0;
    const policy = { async reserve() { return null; }, async release() { if (++calls === 1) { entered.resolve(); if (await gate.promise === 'fail') throw new Error('completion release failed'); return; } if (order.startsWith('the sweep')) throw new Error('sweep release failed'); } };
    const w = world(t, { policy }), p = w.prepare(), capability = await running(w, p), completing = capability.complete(presented(p.input.jobId));
    await entered.promise; assert.equal(w.row(p.input.jobId).cleanup.releasePending, true);
    await w.admission.sweep({ startup: false });
    if (order.startsWith('the completion')) {
      assert.equal(w.row(p.input.jobId).cleanup.releasePending, false, order); gate.resolve('fail');
    } else {
      assert.equal(w.row(p.input.jobId).cleanup.releasePending, true, order); assert.equal(w.row(p.input.jobId).cleanup.tries, 1, order); gate.resolve();
    }
    await completing; await sweepTwice(w);
    const cleaned = w.row(p.input.jobId).cleanup;
    assert.equal(cleaned.releasePending, false, order); assert.equal(cleaned.cause, null, order); assert.equal(w.admission.cleanupPending(), false, order);
    w.reopen(); await sweepTwice(w, true); assert.equal(w.admission.cleanupPending(), false, order);
  }
});

test('P09b-T24 a definite failed bootstrap closes the job; a fresh Start on another job is admitted; the old request\'s recovery ends null', async t => {
  const w = world(t), old = w.prepare(0x11), fresh = w.prepare(0x22); w.control.beforeReserve = () => 'budget-refused';
  await reject(w.admission.begin(old.input), 'seller_budget_refused', 409); await drained(w, old.input.jobId); w.control.beforeReserve = null;
  assert.equal(w.row(old.input.jobId).state, 'aborted');
  assert.deepEqual(w.store.challenges.attempt(old.attempt), { kind: 'refused', code: 'context_challenge_failed', status: 409, cause: 'seller_budget_refused' });
  await reject(w.admission.begin(old.input), 'context_job_closed', 409);
  await reject(w.admission.reserveContext(old.input.jobId, w.reserveWire), 'context_admission_closed', 409); assert.equal(w.calls.wire, 0);
  await w.admission.begin(fresh.input); await w.admission.reserveContext(fresh.input.jobId, w.reserveWire);
  assert.equal(w.row(fresh.input.jobId).state, 'running'); assert.equal(w.row(old.input.jobId).state, 'aborted'); assert.equal(w.calls.wire, 1);
});

test('P09b-T30 with the shipped guard off, `begin` and `compensate` refuse before any write', async () => {
  const probe = fileURLToPath(new URL('./helpers/admission-guard-off-probe.mjs', import.meta.url));
  const kept = (process.env.NODE_OPTIONS ?? '').split(' ').filter(option => option !== '' && !option.includes('kit-guard-fixture.mjs')).join(' ');
  const child = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: kept } });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { begin: 'kit_operation_guard_off', compensate: 'kit_operation_guard_off', written: 0, portCalls: 0 });
});

test('P09b-T33 attempt A paused before D7, recovery B issued; A completes before and after B\'s completion, with equal and different outcomes: A never completes B, changes B\'s outcome, settles the admission or releases the hold; the same with C1 between D6 and D7, and across restart. Round 3, both orderings against compensation: (1) A paused after its durable Vet work and before D7; C1 and compensation run with no context outcome; A released refuses `context_admission_closed` and adds no end or outcome, and no replay becomes available. Here the row stays `compensating`, because C3\'s `executed` proof is P11d3\'s; P11d3 reruns this ordering to settlement `none` (H-19). (2) A publishes its successful outcome before C1; compensation sees it and settles `success` through the completed-context branch. Each asserts the admission revision, the exact journal files, the allocation-hook calls, the hold and `admissionRecord` after two sweeps and a restart', async t => {
  for (const [label, answer] of [['equal', outcome], ['different', { status: 200, text: '{"disposition":"indeterminate","other":true}' }]]) {
    const w = world(t), p = w.prepare(), a = await running(w, p), b = await w.admission.reserveContext(p.input.jobId, w.reserveWire);
    assert.equal(b.attempt, a.attempt + 1, label);
    await reject(a.complete(answer), 'context_admission_closed', 409); await reject(a.complete(null), 'context_admission_closed', 409);
    assert.equal(w.calls.complete.length, 0, label); assert.equal(w.row(p.input.jobId).state, 'running'); assert.equal(w.holds.size, 1);
    await b.complete(outcome); await reject(a.complete(answer), 'context_admission_closed', 409);
    assert.equal(w.calls.complete.length, 1, label); assert.deepEqual(w.wireEnds.get(b.attempt), outcome); assert.equal(w.wireEnds.has(a.attempt), false);
    assert.equal(w.row(p.input.jobId).state, 'settled'); assert.equal(w.calls.effective, 1, label);
  }
  const fenced = world(t), q = fenced.prepare(), c = await running(fenced, q);
  assert.equal(fenced.admission.runningCheck(q.input.jobId, c.attempt, c.rev), true); fenced.compensating(q.input.jobId);
  await reject(c.complete(outcome), 'context_admission_closed', 409); assert.equal(fenced.calls.complete.length, 0); assert.equal(fenced.row(q.input.jobId).state, 'compensating');
  // (1) A is paused after durable Vet work; C1 and compensation find no outcome. P11d3's executed proof is what would settle it, so the row stays.
  const paused = world(t), r = paused.prepare(), d = await running(paused, r); assert.equal(paused.admission.runningCheck(r.input.jobId, d.attempt, d.rev), true);
  paused.control.evidence = record => paused.evidenceOf(record, 'executed');
  const observe = () => ({ record: paused.admission.admissionRecord(r.input.jobId), row: paused.row(r.input.jobId), complete: paused.calls.complete.length, holds: paused.holds.size, effective: paused.calls.effective });
  await paused.admission.compensate(r.input.jobId, 'd'); const held = observe();
  await reject(d.complete(outcome), 'context_admission_closed', 409); await reject(d.complete(null), 'context_admission_closed', 409);
  await sweepTwice(paused); paused.reopen(); await sweepTwice(paused, true);
  assert.deepEqual(observe(), held); assert.equal(held.record.state, 'compensating'); assert.equal(held.record.contextOutcome, null);
  assert.equal(held.complete, 0); assert.equal(held.holds, 1); assert.equal(held.effective, 0); assert.equal(paused.wireEnds.size, 0);
  // (2) A publishes its successful outcome before C1: compensation sees it and settles `success`.
  const published = world(t), s = published.prepare(), e = await running(published, s); await e.complete(presented(s.input.jobId));
  const done = published.admission.admissionRecord(s.input.jobId); assert.equal(done.state, 'settled');
  const later = world(t), u = later.prepare(); await crashAfterPublish(later, u, presented(u.input.jobId)); await later.admission.compensate(u.input.jobId, 'd');
  const after = later.admission.admissionRecord(u.input.jobId); assert.equal(after.state, 'settled'); assert.equal(after.contextOutcome, 'success');
  await sweepTwice(later); later.reopen(); await sweepTwice(later, true);
  assert.deepEqual(later.admission.admissionRecord(u.input.jobId), after); assert.equal(later.calls.complete.length, 1); assert.equal(later.calls.effective, 1); assert.equal(later.calls.evidence.length, 0);
});

test('P09b-T35 a D4 acceptance hook that refuses compensates exactly as D4\'s limit race (challenge `failed` with its code, hold released); one that succeeds commits with the acceptance; a crash inside D4 leaves neither', async t => {
  const refused = world(t), p = refused.prepare(); refused.db.exec('CREATE TABLE test_acceptance (jobId TEXT PRIMARY KEY)');
  refused.admission.addAcceptanceHook(input => { refused.db.prepare('INSERT INTO test_acceptance VALUES (?)').run(input.jobId); });
  refused.admission.addAcceptanceHook(() => { throw Object.assign(new Error('hook-full'), { code: 'peer_store_capacity', status: 503 }); });
  await reject(refused.admission.begin(p.input), 'peer_store_capacity', 503); await drained(refused, p.input.jobId);
  assert.equal(refused.row(p.input.jobId).state, 'aborted'); failedWith(refused, p, 'peer_store_capacity'); assert.equal(refused.holds.size, 0); assert.equal(refused.calls.effective, 1);
  assert.equal(refused.db.prepare('SELECT COUNT(*) AS n FROM test_acceptance').get().n, 0); assert.equal(refused.internals.admissionCounts().starts, 0);
  const accepted = world(t), q = accepted.prepare(); accepted.db.exec('CREATE TABLE test_acceptance (jobId TEXT PRIMARY KEY)');
  accepted.admission.addAcceptanceHook(input => { accepted.db.prepare('INSERT INTO test_acceptance VALUES (?)').run(input.jobId); });
  await accepted.admission.begin(q.input);
  assert.equal(accepted.row(q.input.jobId).state, 'admitted'); assert.equal(accepted.db.prepare('SELECT COUNT(*) AS n FROM test_acceptance').get().n, 1); assert.equal(accepted.holds.size, 1);
  const crashed = world(t), r = crashed.prepare(); crashed.db.exec('CREATE TABLE test_acceptance (jobId TEXT PRIMARY KEY)');
  crashed.admission.addAcceptanceHook(input => { crashed.db.prepare('INSERT INTO test_acceptance VALUES (?)').run(input.jobId); });
  crashed.kill(() => crashed.row(r.input.jobId)?.state === 'admitted', 'before-commit');
  await assert.rejects(crashed.admission.begin(r.input), Error); await restart(crashed);
  assert.equal(crashed.row(r.input.jobId).state, 'aborted'); assert.equal(crashed.row(r.input.jobId).admittedAt, null); assert.equal(crashed.db.prepare('SELECT COUNT(*) AS n FROM test_acceptance').get().n, 0);
  assert.equal(crashed.store.challenges.retained(r.input.nonce).state, 'failed'); assert.equal(crashed.internals.admissionCounts().starts, 0); assert.equal(crashed.holds.size, 0);
});

test('P09b-T34 `admissionRecord` reads back the row\'s `contextScopeHash` (never the challenge scope hash), nonce and state after restart, writes nothing, and answers null for an unknown job. Round 4: it reports `contextOutcome` as null before settlement and as the recorded class after each settlement (`success`, `vet-non-pass` and `other` by D8a and by compensation), the same after restart', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input);
  const admitted = w.admission.admissionRecord(p.input.jobId);
  assert.equal(admitted.contextScopeHash, p.input.contextScopeHash); assert.notEqual(admitted.contextScopeHash, hash('challenge-scope'));
  assert.equal(admitted.nonce, p.input.nonce); assert.equal(admitted.state, 'admitted'); assert.equal(admitted.contextOutcome, null); assert.equal(admitted.admittedAt, T0);
  w.reopen(); const written = w.changes();
  assert.deepEqual(w.admission.admissionRecord(p.input.jobId), admitted); assert.equal(w.admission.admissionRecord(job(0x77)), null); assert.equal(w.admission.admissionRecord('not a job'), null);
  assert.equal(w.changes() - written, 0, 'reading the record writes nothing');
  for (const [expected, make] of COMPLETED_CLASSES) {
    const byD8a = world(t), q = byD8a.prepare(); await (await running(byD8a, q)).complete(make(q.input.jobId));
    const byCompensation = world(t), r = byCompensation.prepare(); await crashAfterPublish(byCompensation, r, make(r.input.jobId)); await byCompensation.admission.compensate(r.input.jobId, 'd');
    for (const [source, x, jobId] of [['D8a', byD8a, q.input.jobId], ['compensation', byCompensation, r.input.jobId]]) {
      assert.equal(x.admission.admissionRecord(jobId).contextOutcome, expected, `${expected} by ${source}`); assert.equal(x.admission.admissionRecord(jobId).state, 'settled');
      x.reopen(); assert.equal(x.admission.admissionRecord(jobId).contextOutcome, expected, `${expected} by ${source} after restart`);
    }
  }
});

test('P09b-T36 compensation reads the context outcome first: a successful completed outcome settles with `contextOutcome` `success` and is never aborted; a Vet non-pass outcome settles `vet-non-pass`; D8a records the same classes on an ordinary completion; an inspection that throws or reports another binding keeps the row `compensating` with its cause and `ready:false`, also after two sweeps and a restart. Round 4: through both D8a and compensation, `success` is recorded only for a `present` answer whose scope hashes to the row\'s `contextScopeHash`, for the row\'s job, naming both Vet record references. A `present` answer for another scope or job, or missing either reference, a completed `indeterminate`, `absent` or non-Vet `rejected` answer, and outcome text that is not a JSON object each record `other`. T37 covers the D7→D8a crash for all three completed classes, asserting one settlement and one effective hold release by `holdId`; P11b2-T17 checks the slot side. The `none` class needs C3\'s `executed` proof, so P11d3 adds that case (H-19)', async t => {
  const cases = [...COMPLETED_CLASSES, ...ENVELOPE_NON_PASS, ...OTHER_OUTCOMES.map(([label, make]) => ['other', make, label])];
  for (const [expected, make, label = expected] of cases) {
    const byD8a = world(t), q = byD8a.prepare(); await (await running(byD8a, q)).complete(make(q.input.jobId));
    assert.equal(byD8a.admission.admissionRecord(q.input.jobId).contextOutcome, expected, `D8a: ${label}`); assert.equal(byD8a.calls.effective, 1, label);
    const byCompensation = world(t), r = byCompensation.prepare(); await crashAfterPublish(byCompensation, r, make(r.input.jobId)); await byCompensation.admission.compensate(r.input.jobId, 'd');
    assert.equal(byCompensation.admission.admissionRecord(r.input.jobId).contextOutcome, expected, `compensation: ${label}`);
    assert.equal(byCompensation.calls.evidence.length, 0, 'a completed outcome is never aborted and needs no evidence'); assert.equal(byCompensation.calls.effective, 1, label);
  }
  const cause = new Error('journal unreadable');
  const failures = [['an inspection that throws', () => { throw cause; }, 'operation_uncertain'],
    ['another binding', jobId => ({ state: 'completed', binding: hash('another-binding'), outcome: presented(jobId) }), 'context_outcome_binding_mismatch'],
    ['an unknown view', () => ({ state: 'unreadable' }), 'context_outcome_unavailable']];
  for (const [label, inspect, code] of failures) {
    const w = world(t), p = w.prepare(); await crashAfterPublish(w, p, presented(p.input.jobId)); w.control.inspect = () => inspect(p.input.jobId);
    await w.admission.compensate(p.input.jobId, 'd'); await sweepTwice(w); w.reopen(); await sweepTwice(w, true);
    const kept = w.row(p.input.jobId);
    assert.equal(kept.state, 'compensating', label); assert.equal(kept.contextOutcome, null, label); assert.equal(kept.cleanup.cause.code, code, label);
    assert.equal(w.holds.size, 1, label); assert.equal(w.calls.evidence.length, 0, label); assert.equal(w.admission.cleanupPending(), true, label);
    w.control.inspect = null; await w.admission.sweep({ startup: false }); assert.equal(w.admission.admissionRecord(p.input.jobId).contextOutcome, 'success', label);
  }
});

test('P09b-T37 table: durable cut (D1, D2, hold line, D4, D7 before D8a, C1, C3 before C4a) × completed outcome class (`success`, `vet-non-pass`, `other`) wherever that outcome can already exist; mark impossible combinations N/A and exercise pre-outcome cuts with no completed outcome instead. SIGKILL, reopen, retry where K1 permits and run two sweeps: D1 closes `validator_lost` with no admission/hold/journal; D2 aborts with zero holds/starts; a durable hold is released by `holdId` once effectively; D4 continues into D5 with its original hold/start and settles the selected completion. For each D7→D8a class, restart then C1 before sweep: recover the exact durable outcome, settle with that class once, and release the same hold once. At C1/C3, completed outcomes use the outcome-first branch; without an outcome, re-read evidence and abort only on no-effect proof, otherwise retain `compensating`, hold and cause. No C3 evidence step is invented after outcome-first settlement. Assert challenge/admission state, revisions, policy lines, journal files and hook calls after each sweep/reopen; repeat cleanup without double settlement or effective release. `none` settlement and its real sink proof stay at P11d3. P11b2-T17 runs the applicable class/cut slot matrix', async t => {
  // D1: only the challenge is durable. D2, the hold line and D4 cannot hold an outcome (N/A: no wire reservation exists yet); they run without one.
  const d1 = world(t), q = d1.prepare(); await restart(d1);
  assert.equal(d1.row(q.input.jobId), null); assert.equal(d1.holds.size, 0); assert.equal(d1.calls.wire, 0); failedWith(d1, q, 'validator_lost');
  const d2 = world(t), r = d2.prepare(); d2.kill(() => d2.row(r.input.jobId)?.state === 'intent'); await assert.rejects(d2.admission.begin(r.input), Error); await restart(d2);
  assert.equal(d2.row(r.input.jobId).state, 'aborted'); assert.equal(d2.calls.reserve, 0); assert.equal(d2.holds.size, 0); assert.equal(d2.internals.admissionCounts().starts, 0);
  const hold = world(t), s = hold.prepare(); hold.control.beforeReserve = () => { hold.control.killed = true; hold.db.close(); return null; };
  await assert.rejects(hold.admission.begin(s.input), Error); hold.control.beforeReserve = null; await restart(hold);
  assert.equal(hold.row(s.input.jobId).state, 'aborted'); assert.equal(hold.calls.effective, 1); assert.equal(hold.holds.size, 0);
  const d4 = world(t), u = d4.prepare(); d4.kill(() => d4.row(u.input.jobId)?.state === 'admitted'); await assert.rejects(d4.admission.begin(u.input), Error); await restart(d4);
  const kept = d4.row(u.input.jobId); assert.equal(kept.state, 'admitted'); assert.equal(d4.holds.size, 1); assert.equal(d4.internals.admissionCounts().starts, 1); assert.equal(d4.calls.reserve, 1);
  const continued = await d4.admission.reserveContext(u.input.jobId, d4.reserveWire); await continued.complete(presented(u.input.jobId));
  assert.equal(d4.row(u.input.jobId).holdId, kept.holdId); assert.equal(d4.admission.admissionRecord(u.input.jobId).contextOutcome, 'success'); assert.equal(d4.calls.reserve, 1); assert.equal(d4.calls.effective, 1);
  // D7 before D8a, C1 and C3 before C4a, each with every completed class: restart, then C1 before the sweep or the sweep alone; one settlement, one release.
  for (const [expected, make] of COMPLETED_CLASSES) {
    for (const cut of ['D7 then C1 then sweep', 'C1 then restart', 'C3 evidence was read first', 'the startup sweep alone']) {
      const w = world(t), p = w.prepare(); await crashAfterPublish(w, p, make(p.input.jobId)); const { holdId } = w.row(p.input.jobId);
      if (cut === 'C1 then restart') w.compensating(p.input.jobId);
      if (cut === 'C3 evidence was read first') { w.compensating(p.input.jobId); w.control.inspect = () => ({ state: 'none' }); await w.admission.sweep({ startup: false }); w.control.inspect = null; }
      w.reopen(); if (cut === 'D7 then C1 then sweep') await w.admission.compensate(p.input.jobId, 'd');
      const label = `${expected}: ${cut}`; await sweepTwice(w, true); const record = w.admission.admissionRecord(p.input.jobId);
      assert.equal(record.state, cut === 'C3 evidence was read first' ? 'aborted' : 'settled', label);
      if (record.state === 'settled') { assert.equal(record.contextOutcome, expected, label); assert.equal(w.calls.effective, 1, label); assert.equal(w.calls.evidence.length, 0, label); }
      assert.equal(w.holds.size, 0, label); const stable = w.row(p.input.jobId); await sweepTwice(w); assert.deepEqual(w.row(p.input.jobId), stable, label);
      assert.equal(stable.holdId, holdId, label);
    }
  }
});

test('admission-projection-isolation', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input);
  const record = w.admission.admissionRecord(p.input.jobId), stored = w.row(p.input.jobId);
  assert.deepEqual(Object.keys(record).sort(), ['admittedAt', 'buyer', 'contextOutcome', 'contextScopeHash', 'jobId', 'listingPin', 'nonce', 'presentationHash', 'rev', 'seller', 'state']);
  assert.equal(Object.isFrozen(record), true); assert.equal(Object.isFrozen(record.listingPin), true);
  assert.throws(() => { record.state = 'settled'; }, TypeError); assert.throws(() => { record.listingPin.version = 9; }, TypeError);
  assert.notStrictEqual(w.admission.admissionRecord(p.input.jobId), record); assert.deepEqual(w.row(p.input.jobId), stored); assert.equal(w.admission.admissionRecord(p.input.jobId).state, 'admitted');
});

test('admission-policy-startup-owner', async t => {
  const w = world(t), evidencePath = join(w.directory, 'policy.jsonl');
  const real = createSellerContextAdmission({ evidencePath, sellerApproval: { mode: 'policy' }, now: () => T0 });
  w.options.policy = real; w.reopen(); const p = w.prepare(); await w.admission.begin(p.input); assert.equal(openHolds(evidencePath), 1);
  // The K1 composition has no legacy store: a restart, the startup sweep and a periodic one leave the live hold to the sweep's own rules.
  const owner = createSellerContextAdmission({ evidencePath, sellerApproval: { mode: 'policy' }, now: () => T0 }); await owner.ready;
  w.options.policy = owner; w.reopen(); await sweepTwice(w, true); assert.equal(w.row(p.input.jobId).state, 'admitted'); assert.equal(openHolds(evidencePath), 1);
  // The legacy startup reconciler reads only the old table's peer_* state, finds none for this job and releases the live hold: why K1 must not pass its store.
  await createSellerContextAdmission({ evidencePath, sellerApproval: { mode: 'policy' }, transportStore: w.store, now: () => T0 }).ready;
  assert.equal(openHolds(evidencePath), 0, 'the legacy reconciler would have ended the live hold');
});

test('admission-sweep-repeat-fault', async t => {
  const w = world(t), failing = w.prepare(0x11), releasing = w.prepare(0x22), settled = w.prepare(0x33);
  await running(w, failing); await w.admission.begin(releasing.input); await w.admission.begin(settled.input);
  w.control.evidence = record => { if (record.jobId === failing.input.jobId) throw new Error('journal unreadable'); return w.evidenceOf(record, 'no-intent'); };
  w.control.releaseFault = new Error('acknowledgement lost');
  await w.admission.compensate(failing.input.jobId, 'd'); await w.admission.compensate(releasing.input.jobId, 'd');
  w.control.releaseFault = null; w.control.unavailable = new Error('policy ledger unavailable');
  await w.admission.sweep({ startup: false }); await w.admission.sweep({ startup: false });
  assert.equal(w.row(failing.input.jobId).state, 'compensating'); assert.equal(w.row(releasing.input.jobId).cleanup.releasePending, true);
  assert.equal(w.row(settled.input.jobId).state, 'admitted'); assert.equal(w.admission.cleanupPending(), true); assert.equal(w.holds.size, 2);
  w.control.evidence = null; w.control.unavailable = null; await w.admission.sweep({ startup: false });
  assert.equal(w.row(failing.input.jobId).state, 'aborted'); assert.equal(w.row(releasing.input.jobId).cleanup.releasePending, false); assert.equal(w.holds.size, 1);
  assert.equal(w.admission.cleanupPending(), false); const stable = [failing, releasing, settled].map(x => w.row(x.input.jobId)); const effective = w.calls.effective;
  await sweepTwice(w); await restart(w);
  assert.deepEqual([failing, releasing, settled].map(x => w.row(x.input.jobId)), stable); assert.equal(w.calls.effective, effective);
});

test('admission-evidence-set-must-cover-both-composite-addresses', async t => {
  const w = world(t), p = w.prepare(); await running(w, p); const foreign = compositeVerificationAddress(job(0x99), SELLER);
  const both = record => [record.vetAddresses.buyer, record.vetAddresses.seller];
  const incomplete = [['an empty answer', () => []], ['not an array', () => 'no-intent'], ['the buyer address only', record => [{ address: both(record)[0], kind: 'no-intent' }]],
    ['the seller address only', record => [{ address: both(record)[1], kind: 'no-intent' }]], ['a foreign address for the seller', record => [{ address: both(record)[0], kind: 'no-intent' }, { address: foreign, kind: 'no-intent' }]],
    ['the buyer address twice', record => [{ address: both(record)[0], kind: 'no-intent' }, { address: both(record)[0], kind: 'no-intent' }]],
    ['a third entry', record => [...w.evidenceOf(record, 'no-intent'), { address: foreign, kind: 'no-intent' }]], ['entries that are not records', () => [null, 7]]];
  for (const [label, evidence] of incomplete) {
    w.control.evidence = evidence; await w.admission.compensate(p.input.jobId, 'd');
    assert.equal(w.row(p.input.jobId).state, 'compensating', label); assert.equal(w.holds.size, 1, label); assert.equal(w.calls.release, 0, label);
  }
  const mapped = world(t), q = mapped.prepare(); await running(mapped, q); const saved = mapped.row(q.input.jobId);
  const corrupt = [['an address that does not follow its presenter', { ...saved, vetAddresses: { ...saved.vetAddresses, buyer: foreign } }],
    ['colliding addresses', { ...saved, vetAddresses: { buyer: saved.vetAddresses.seller, seller: saved.vetAddresses.seller } }], ['a missing mapping', { ...saved, vetAddresses: undefined }]];
  for (const [label, record] of corrupt) {
    mapped.db.prepare('UPDATE kit_context_admissions SET record = ? WHERE jobId = ?').run(JSON.stringify(record), q.input.jobId); const evidenceCalls = mapped.calls.evidence.length;
    await mapped.admission.compensate(q.input.jobId, 'd');
    assert.equal(mapped.row(q.input.jobId).state, 'compensating', label); assert.equal(mapped.calls.evidence.length, evidenceCalls, `${label}: nothing is read for an unverified mapping`); assert.equal(mapped.holds.size, 1, label);
    mapped.db.prepare('UPDATE kit_context_admissions SET record = ? WHERE jobId = ?').run(JSON.stringify(saved), q.input.jobId);
  }
  w.control.evidence = record => record.vetAddresses && [{ address: both(record)[0], kind: 'proven-unsigned' }, { address: both(record)[1], kind: 'no-intent' }]; await w.admission.compensate(p.input.jobId, 'd');
  assert.equal(w.row(p.input.jobId).state, 'aborted'); assert.equal(w.holds.size, 0); assert.deepEqual(w.row(p.input.jobId).compensation.evidence.map(entry => entry.kind), ['proven-unsigned', 'no-intent']);
});

test('admission-evidence-addresses-follow-presenter-spelling', async t => {
  const sellerSpelling = `${SELLER}?jurisdiction=GB`;
  for (const [role, arrange] of [['buyer', p => { p.input.sellerBundlePresentedBy = SELLER; }], ['seller', p => { p.input.sellerBundlePresentedBy = sellerSpelling; }]]) {
    const w = world(t), p = w.prepare(0x11, BUYER, { presenter: EQUIVALENT_BUYER }); arrange(p); await running(w, p);
    const saved = w.row(p.input.jobId), journal = new Set([saved.vetAddresses[role]]), request = { buyer: compositeVerificationAddress(p.input.jobId, BUYER), seller: compositeVerificationAddress(p.input.jobId, SELLER) };
    assert.equal(saved.vetAddresses.buyer, compositeVerificationAddress(p.input.jobId, EQUIVALENT_BUYER)); assert.notEqual(saved.vetAddresses[role], request[role]);
    w.control.evidence = record => [record.vetAddresses.buyer, record.vetAddresses.seller].map(address => ({ address, kind: journal.has(address) ? 'undetermined' : 'no-intent' }));
    await w.admission.compensate(p.input.jobId, 'd'); await sweepTwice(w); await restart(w);
    assert.equal(w.row(p.input.jobId).state, 'compensating', role); assert.equal(w.holds.size, 1, role); assert.equal(w.calls.release, 0, role);
    assert.ok(w.calls.evidence.every(read => read.buyer === saved.vetAddresses.buyer && read.seller === saved.vetAddresses.seller), `${role}: exactly the retained presenter addresses were read`);
    journal.clear(); await w.admission.sweep({ startup: false });
    assert.equal(w.row(p.input.jobId).state, 'aborted', `${role}: no intent at both correct addresses is the positive control`); assert.equal(w.holds.size, 0);
  }
});

test('admission-periodic-sweep-spares-live-begin', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = world(t), p = waiting.prepare(), occupied = deferred(), entered = deferred();   // D2 committed, D3 not yet holding the mutex
  const held = waiting.admission.jobEffectMutex(p.input.jobId).run(async () => { entered.resolve(); await occupied.promise; }); await entered.promise;
  const start = waiting.admission.begin(p.input), intent = waiting.row(p.input.jobId);
  await waiting.admission.sweep({ startup: false }); assert.deepEqual(waiting.row(p.input.jobId), intent); assert.equal(waiting.store.challenges.retained(p.input.nonce).state, 'attempted');
  assert.equal(waiting.admission.cleanupPending(), false); await assert.rejects(waiting.admission.sweep({ startup: true }), TypeError); assert.deepEqual(waiting.row(p.input.jobId), intent);
  occupied.resolve(); await held; await start; assert.equal(waiting.row(p.input.jobId).state, 'admitted'); assert.equal(waiting.calls.reserve, 1); assert.equal(waiting.holds.size, 1);
  const slow = world(t), q = slow.prepare(), inside = deferred(), barrier = deferred();   // inside the policy call, just below its deadline
  slow.control.beforeReserve = () => { inside.resolve(); return barrier.promise; };
  const slowStart = slow.admission.begin(q.input); await inside.promise; t.mock.timers.tick(POLICY_MS - 1);
  const pendingIntent = slow.row(q.input.jobId); await slow.admission.sweep({ startup: false });
  assert.deepEqual(slow.row(q.input.jobId), pendingIntent); assert.equal(slow.row(q.input.jobId).state, 'intent');
  barrier.resolve(null); await slowStart; assert.equal(slow.row(q.input.jobId).state, 'admitted'); assert.equal(slow.calls.reserve, 1); assert.equal(slow.internals.admissionCounts().starts, 1);
  const late = world(t), r = late.prepare(), lateInside = deferred(), lateBarrier = deferred();   // genuine trigger (a) still fences; the late call keeps the lease until it can be released
  late.control.beforeReserve = () => { lateInside.resolve(); return lateBarrier.promise; };
  const lateStart = assert.rejects(late.admission.begin(r.input), error => error.code === 'seller_budget_unavailable'); await lateInside.promise; t.mock.timers.tick(POLICY_MS); await lateStart;
  const swept = late.admission.sweep({ startup: false }); await flush(); assert.equal(late.row(r.input.jobId).state, 'compensating'); assert.equal(late.holds.size, 1);
  lateBarrier.resolve(null); await swept; assert.equal(late.row(r.input.jobId).state, 'aborted'); assert.equal(late.holds.size, 0); assert.equal(late.calls.effective, 1);
  const operator = world(t), s = operator.prepare(), gate = deferred(), got = deferred();   // operator (d) fences an owned begin
  const lease = operator.admission.jobEffectMutex(s.input.jobId).run(async () => { got.resolve(); await gate.promise; }); await got.promise;
  const operatorStart = assert.rejects(operator.admission.begin(s.input), Error); await operator.admission.sweep({ startup: false });
  assert.equal(operator.row(s.input.jobId).state, 'intent'); const abort = operator.admission.compensate(s.input.jobId, 'd');
  assert.equal(operator.row(s.input.jobId).state, 'compensating'); gate.resolve(); await lease; await operatorStart; await abort; assert.equal(operator.row(s.input.jobId).state, 'aborted');
});

test('admission-live-begin-owner-registered-in-the-commit-turn-and-kept-through-d3-and-d4', async t => {
  const w = world(t), gateFor = gatedPolicy(w); w.reopen();
  const p = w.prepare(), { jobId } = p.input, gate = gateFor(jobId);
  assert.equal(owned(w, jobId, 1), false);
  const begun = w.admission.begin(p.input);
  // No await since the call: the intent is committed and its owner is already registered, for that revision only.
  assert.equal(w.row(jobId).state, 'intent'); assert.equal(owned(w, jobId, 1), true);
  assert.equal(owned(w, jobId, 2), false); assert.equal(owned(w, job(0x77), 1), false);
  await gate.entered.promise;
  assert.equal(w.row(jobId).cleanup.holdCall, 'pending'); assert.equal(owned(w, jobId, 1), true);
  gate.barrier.resolve(null); await begun;
  assert.equal(w.row(jobId).state, 'admitted');
  await w.admission.jobEffectMutex(jobId).run(() => {}); await flush();
  assert.equal(owned(w, jobId, 1), false);
  w.reopen(); assert.equal(owned(w, jobId, 1), false);
});

test('admission-live-begin-owner-reader-is-off-the-api-and-refuses-a-foreign-object', async t => {
  const w = world(t);
  assert.equal('ownedIntent' in w.admission, false); assert.equal(Object.keys(admissionTransactionInternals(w.admission)).join(), 'ownedIntent');
  for (const foreign of [{}, { ...w.admission }, null, undefined]) assert.throws(() => admissionTransactionInternals(foreign), TypeError);
});

test('admission-live-begin-owner-is-not-registered-for-a-refused-or-uncommitted-intent', async t => {
  const w = world(t), p = w.prepare(), q = w.prepare(0x12); w.control.ready = false;
  await reject(w.admission.begin(p.input), 'seller_not_ready', 503);
  assert.equal(w.row(p.input.jobId), null); assert.equal(owned(w, p.input.jobId, 1), false);
  w.control.ready = true; w.cut('before-commit', () => w.row(q.input.jobId)?.state === 'intent');
  await assert.rejects(w.admission.begin(q.input), /cut-before-commit/);
  assert.equal(owned(w, q.input.jobId, 1), false);
});

test('admission-live-begin-owner-is-kept-through-the-late-policy-settlement', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world(t), gateFor = gatedPolicy(w); w.reopen();
  const p = w.prepare(), { jobId } = p.input, gate = gateFor(jobId);
  const begun = w.admission.begin(p.input), rejected = reject(begun, 'seller_budget_unavailable', 503);
  await gate.entered.promise; t.mock.timers.tick(POLICY_MS); await rejected; await flush();
  // The outward answer is the deadline; the policy call has not ended, so the failure is recorded but the owner stays.
  assert.equal(w.row(jobId).state, 'compensating'); assert.equal(owned(w, jobId, 1), true); assert.equal(w.calls.release, 0);
  gate.barrier.resolve(null); await w.admission.jobEffectMutex(jobId).run(() => {}); await flush();
  assert.equal(owned(w, jobId, 1), false); assert.equal(w.calls.release, 1);
});

test('admission-live-begin-owner-is-removed-only-by-its-own-begin', async t => {
  const w = world(t), gateFor = gatedPolicy(w); w.reopen();
  const a = w.prepare(0x11), b = w.prepare(0x12), gate = gateFor(a.input.jobId);
  const first = w.admission.begin(a.input), firstRejected = reject(first, 'context_admission_closed', 409);
  await gate.entered.promise;
  // Another job's begin ends, a repeated begin of the same job is refused, and C1 lands from outside: none of them touches the owner.
  await w.admission.begin(b.input); await w.admission.jobEffectMutex(b.input.jobId).run(() => {}); await flush();
  assert.equal(owned(w, b.input.jobId, 1), false); assert.equal(owned(w, a.input.jobId, 1), true);
  await reject(w.admission.begin(a.input), 'context_job_closed', 409); assert.equal(owned(w, a.input.jobId, 1), true);
  w.compensating(a.input.jobId); await flush(); assert.equal(owned(w, a.input.jobId, 1), true);
  gate.barrier.resolve(null); await firstRejected; await w.admission.jobEffectMutex(a.input.jobId).run(() => {}); await flush();
  assert.equal(owned(w, a.input.jobId, 1), false); assert.equal(w.row(a.input.jobId).state, 'aborted');   // P09bb's C2-C4 settle it under the same lease
});

// Moves the mocked clock on in steps until `promise` settles, letting every pending turn run between steps; fails if it never settles.
async function driveUntil(t, promise, stepMs = 1000) {
  let done = false; promise.then(() => { done = true; }, () => { done = true; });
  for (let step = 0; step < 200 && !done; step++) { await flush(); t.mock.timers.tick(stepMs); }
  await flush(); assert.equal(done, true, 'the call settled within the mocked deadlines');
  return promise;
}
const killedAtTheHoldLine = async (w, p) => {
  w.control.beforeReserve = () => { w.control.killed = true; w.db.close(); return null; };
  await assert.rejects(w.admission.begin(p.input), Error); w.control.beforeReserve = null; w.reopen();
};

test('admission-sweep-moves-past-a-row-whose-evidence-lease-or-release-never-answers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const never = new Promise(() => {});
  for (const hang of ['evidence', 'lease', 'release']) {
    const w = world(t);
    if (hang === 'release') { const base = w.policy; w.options.policy = { reserve: base.reserve, release: request => (request.jobId === job(0x11) ? never : base.release(request)) }; w.reopen(); }
    const a = w.prepare(0x11), b = w.prepare(0x22); await w.admission.begin(a.input); await w.admission.begin(b.input);
    if (hang === 'release') await driveUntil(t, w.admission.compensate(a.input.jobId, 'd'));
    else w.compensating(a.input.jobId);
    if (hang === 'evidence') w.control.evidence = record => (record.jobId === a.input.jobId ? never : w.evidenceOf(record, 'no-intent'));
    if (hang === 'lease') void w.admission.jobEffectMutex(a.input.jobId).run(() => never);
    w.control.clock = T0 + HOUR + 30000;
    await driveUntil(t, w.admission.sweep({ startup: false }));
    assert.equal(w.row(b.input.jobId).state, 'aborted', hang); assert.equal(w.holds.has(w.row(b.input.jobId).holdId), false, hang);
    assert.notEqual(w.row(a.input.jobId).cleanup.cause, null, hang); assert.equal(w.holds.has(w.row(a.input.jobId).holdId), true, hang); assert.equal(w.admission.cleanupPending(), true, hang);
  }
  const w = world(t), p = w.prepare(); await running(w, p); w.compensating(p.input.jobId);
  const first = w.admission.sweep({ startup: false }), second = w.admission.sweep({ startup: false });
  assert.strictEqual(second, first); await assert.rejects(w.admission.sweep({ startup: true }), TypeError);
  await first; assert.equal(w.calls.evidence.length, 1, 'two overlapping sweeps make one pass'); assert.equal(w.row(p.input.jobId).state, 'aborted');
});

test('admission-completed-wire-answer-settles-the-row-where-it-arrives', async t => {
  for (const [expected, make] of COMPLETED_CLASSES) {
    for (const from of ['admitted', 'running']) {
      const label = `${expected} from ${from}`, w = world(t), p = w.prepare(); p.input.delegationExpiresAt = null; await w.admission.begin(p.input);
      if (from === 'running') await w.admission.reserveContext(p.input.jobId, w.reserveWire);
      const answer = make(p.input.jobId), done = { state: 'completed', operationId: hash('wire-operation'), outcome: answer };
      w.control.inspect = jobId => ({ state: 'completed', binding: w.row(jobId).contextBinding, outcome: answer });
      assert.strictEqual(await w.admission.reserveContext(p.input.jobId, async () => done), done, label);
      const settled = w.admission.admissionRecord(p.input.jobId);
      assert.equal(settled.state, 'settled', label); assert.equal(settled.contextOutcome, expected, label); assert.equal(w.holds.size, 0, label);
      assert.equal(w.calls.effective, 1, label); assert.equal(w.calls.evidence.length, 0, label); assert.equal(w.admission.cleanupPending(), false, label);
      await sweepTwice(w); w.reopen(); await sweepTwice(w, true);
      assert.deepEqual(w.admission.admissionRecord(p.input.jobId), settled, label); assert.equal(w.calls.effective, 1, label);
    }
  }
});

test('admission-an-ended-policy-call-is-settled-by-a-later-periodic-sweep-without-another-restart', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const failures = [
    ['the startup evidence read fails', w => { w.control.evidence = () => { throw new Error('journal unreadable'); }; }, w => { w.control.evidence = null; }],
    ['the startup release fails', w => { w.control.unavailable = new Error('policy ledger unavailable'); }, w => { w.control.unavailable = null; }],
    ['the startup adoption commit fails', (w, p) => w.cut('before-commit', () => w.row(p.input.jobId)?.cleanup.holdCall === 'settled'), () => {}],
  ];
  for (const [label, arrange, recover] of failures) {
    const w = world(t), p = w.prepare(); await killedAtTheHoldLine(w, p); assert.equal(w.row(p.input.jobId).cleanup.holdCall, 'pending', label);
    arrange(w, p); await driveUntil(t, w.admission.sweep({ startup: true }));
    assert.equal(w.holds.size, 1, label); assert.equal(w.admission.cleanupPending(), true, label);
    recover(w); await driveUntil(t, w.admission.sweep({ startup: false }));
    assert.equal(w.row(p.input.jobId).state, 'aborted', label); assert.equal(w.row(p.input.jobId).cleanup.holdCall, 'settled', label);
    assert.equal(w.holds.size, 0, label); assert.equal(w.calls.effective, 1, label); assert.equal(w.admission.cleanupPending(), false, label);
  }
  // This process's own late call: recording its end fails, and the begin that owned it ends.
  const w = world(t), p = w.prepare(), entered = deferred(), barrier = deferred();
  w.control.beforeReserve = () => { entered.resolve(); return barrier.promise; };
  const rejected = reject(w.admission.begin(p.input), 'seller_budget_unavailable', 503); await entered.promise; t.mock.timers.tick(POLICY_MS); await rejected;
  w.cut('before-commit', () => w.row(p.input.jobId).cleanup.holdCall === 'settled'); barrier.resolve(null); await drained(w, p.input.jobId); await flush();
  assert.equal(w.row(p.input.jobId).cleanup.holdCall, 'pending'); assert.equal(owned(w, p.input.jobId, 1), false); assert.equal(w.holds.size, 1);
  await driveUntil(t, w.admission.sweep({ startup: false }));
  assert.equal(w.row(p.input.jobId).state, 'aborted'); assert.equal(w.holds.size, 0); assert.equal(w.calls.effective, 1); assert.equal(w.admission.cleanupPending(), false);
});

test('admission-a-fault-that-ends-leaves-no-cause-on-a-live-row', async t => {
  const w = world(t), p = w.prepare(); await running(w, p);
  const faults = [['an inspection fault', () => { w.control.inspect = () => { throw new Error('journal unreadable'); }; }, () => { w.control.inspect = null; }, 'operation_uncertain'],
    ['a seller clock fault', () => { w.control.clock = -1; }, () => { w.control.clock = T0; }, 'peer_clock_invalid']];
  for (const [label, arrange, recover, code] of faults) {
    for (const pass of [() => w.admission.sweep({ startup: false }), () => w.admission.compensate(p.input.jobId, 'c')]) {
      arrange(); await pass();
      assert.equal(w.row(p.input.jobId).cleanup.cause.code, code, label); assert.equal(w.admission.cleanupPending(), true, label);
      recover(); await pass();
      assert.equal(w.row(p.input.jobId).state, 'running', label); assert.equal(w.row(p.input.jobId).cleanup.cause, null, label); assert.equal(w.admission.cleanupPending(), false, label);
    }
  }
  assert.equal(w.holds.size, 1); assert.equal(w.calls.release, 0);
});

test('admission-sweep-reports-a-row-it-could-not-record-and-still-reaches-the-rows-after-it', async t => {
  const w = world(t), a = w.prepare(0x11), b = w.prepare(0x22); await running(w, a); await w.admission.begin(b.input); w.compensating(a.input.jobId);
  w.control.evidence = record => { if (record.jobId === a.input.jobId) throw new Error('journal unreadable'); return w.evidenceOf(record, 'no-intent'); };
  w.control.clock = T0 + HOUR + 30000;
  const exec = w.db.exec.bind(w.db), fault = new Error('diagnostic write failed');
  w.db.exec = sql => { if (sql === 'COMMIT' && w.row(a.input.jobId).cleanup.cause !== null) throw fault; return exec(sql); };
  await assert.rejects(w.admission.sweep({ startup: false }), error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0] === fault);
  assert.equal(w.row(b.input.jobId).state, 'aborted'); assert.equal(w.holds.has(w.row(b.input.jobId).holdId), false);
  assert.equal(w.row(a.input.jobId).state, 'compensating'); assert.equal(w.admission.cleanupPending(), true);
});

test('admission-compensate-and-sweep-refuse-malformed-arguments-and-an-unknown-job-is-a-no-op', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input); w.control.clock = T0 + 1; const before = w.changes();
  for (const trigger of [['c'], ['d'], 'constructor', 'e', null]) await assert.rejects(w.admission.compensate(p.input.jobId, trigger), TypeError, String(trigger));
  await assert.rejects(w.admission.compensate('not a job', 'd'), TypeError);
  await w.admission.compensate(job(0x77), 'd'); assert.equal(w.row(job(0x77)), null);
  for (const options of [undefined, {}, { startup: 'yes' }, { startup: 1 }]) await assert.rejects(w.admission.sweep(options), TypeError);
  assert.equal(w.changes() - before, 0); assert.equal(w.row(p.input.jobId).state, 'admitted');
});

// K11: every entry that reaches the wire, the journal or the policy refuses while the guard is off, before it takes the job lease.
const guard = await import('../src/kit-operation-guard.mjs');
const guardOff = (promise, entry) => assert.rejects(promise, { code: 'kit_operation_guard_off', entry });

test('admission-reserve-refused-while-the-guard-is-off-on-an-admitted-row', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input);
  const before = w.row(p.input.jobId); t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  guard.setKitOperationGuardForTest('off');
  await guardOff(w.admission.reserveContext(p.input.jobId, w.reserveWire), 'reserveContext');
  await guardOff(w.admission.reserveContext(p.input.jobId, null), 'reserveContext');
  assert.equal(w.calls.wire, 0); assert.deepEqual(w.row(p.input.jobId), before);
  await w.admission.jobEffectMutex(p.input.jobId).run(() => {});
  guard.setKitOperationGuardForTest('testnet-tp1');
  assert.equal((await w.admission.reserveContext(p.input.jobId, w.reserveWire)).attempt, 0); assert.equal(w.calls.wire, 1);
});

test('admission-complete-refused-while-the-guard-is-off-on-a-running-row', async t => {
  const w = world(t), p = w.prepare(), capability = await running(w, p); t.after(() => guard.setKitOperationGuardForTest('testnet-tp1'));
  const before = w.row(p.input.jobId);
  guard.setKitOperationGuardForTest('off');
  await guardOff(capability.complete(outcome), 'complete');
  await guardOff(capability.complete(null), 'complete');
  assert.equal(w.calls.complete.length, 0); assert.equal(w.calls.release, 0); assert.equal(w.holds.size, 1); assert.deepEqual(w.row(p.input.jobId), before);
  await w.admission.jobEffectMutex(p.input.jobId).run(() => {});
  guard.setKitOperationGuardForTest('testnet-tp1');
  await capability.complete(outcome);
  assert.equal(w.row(p.input.jobId).state, 'settled'); assert.equal(w.calls.complete.length, 1); assert.equal(w.holds.size, 0);
});

test('admission-sweep-with-the-guard-off-finishes-an-existing-release-and-starts-nothing', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input); w.control.unavailable = new Error('policy ledger unavailable');
  await w.admission.compensate(p.input.jobId, 'd'); assert.equal(w.row(p.input.jobId).cleanup.releasePending, true); assert.equal(w.holds.size, 1);
  t.after(() => guard.setKitOperationGuardForTest('testnet-tp1')); guard.setKitOperationGuardForTest('off'); w.control.unavailable = null;
  await guardOff(w.admission.compensate(p.input.jobId, 'd'), 'compensate'); assert.equal(w.row(p.input.jobId).cleanup.releasePending, true);
  await w.admission.sweep({ startup: false });
  assert.equal(w.row(p.input.jobId).cleanup.releasePending, false); assert.equal(w.holds.size, 0); assert.equal(w.calls.reserve, 1); assert.equal(w.calls.wire, 0);
});

test('admission-live-begin-owner-is-held-while-the-d4-hooks-run-and-removed-after-a-hook-refusal-is-recorded', async t => {
  const seen = [], capacity = { fitsNewPurchase: () => true, allocateWithin: () => {} };
  const w = world(t, { capacity }), p = w.prepare(), { jobId } = p.input;
  w.admission.addAcceptanceHook(() => { seen.push(['hook', owned(w, jobId, 1), w.row(jobId).state]); throw Object.assign(new Error('hook-full'), { code: 'peer_store_capacity', status: 503 }); });
  await reject(w.admission.begin(p.input), 'peer_store_capacity', 503);
  assert.deepEqual(seen, [['hook', true, 'admitted']]);
  await w.admission.jobEffectMutex(jobId).run(() => {}); await flush();
  // The refusal is compensated under the same lease: no effect happened, so the row aborts and its hold is released.
  assert.equal(w.row(jobId).state, 'aborted'); assert.equal(w.holds.size, 0); assert.equal(w.calls.effective, 1); assert.equal(owned(w, jobId, 1), false);
});

// D21: accounting sees durable K1 rows before any purchase tuple exists, as well as after restart.
const accountingInput = (jobId, path, buyer = BUYER) => {
  const payload = { version: '1', kind: 'request', method: 'POST', path, jobId, buyer, seller: SELLER, listingPin: PIN,
    agreementHash: hash('accounting agreement'), bodyHash: hash('{}'), nonce: hash('accounting nonce'), expiresAt: T0 + 60000, profile: PROFILE };
  return { payload, route: path, operationId: wireOperationId(payload), keepProfile: PROFILE,
    checked: { body: {}, reserve: async () => { throw new Error('refused accounting reached wire reservation'); } } };
};
for (const limit of ['jobs', 'context']) test(`D21 accounting counts K1 intent and admitted rows without tuples toward ${limit}`, async t => {
  const w = world(t, { maxJobs: limit === 'jobs' ? 1 : 20, maxContextRecords: limit === 'context' ? 1 : 20 });
  const gate = deferred(); w.control.beforeReserve = () => gate.promise.then(() => null);
  const { input } = w.prepare(), pending = w.admission.begin(input);
  await flush();
  const args = accountingInput(job(0x22), limit === 'jobs' ? '/dacs/v1/agreements/proposals' : SELLER_CONTEXT_PATH);
  const refusal = { code: limit === 'jobs' ? 'peer_job_capacity' : 'peer_context_capacity', status: 503 };
  try {
    assert.equal(w.row(input.jobId).state, 'intent');
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM kit_purchase_profiles').get().n, 0);
    await assert.rejects(w.store.reservationAccounting.reserveAccounted(args), refusal);
  } finally { gate.resolve(); await pending; }
  w.reopen();
  assert.equal(w.row(input.jobId).state, 'admitted');
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM kit_purchase_profiles').get().n, 0);
  await assert.rejects(w.store.reservationAccounting.reserveAccounted(args), refusal);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n, 0);
});
test('D21 accounting keeps the K1 row owner before a purchase tuple exists', async t => {
  const w = world(t), { input } = w.prepare();
  await w.admission.begin(input);
  await assert.rejects(w.store.reservationAccounting.reserveAccounted(accountingInput(input.jobId, '/dacs/v1/agreements/proposals', OTHER)),
    { code: 'peer_job_conflict', status: 409 });
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n, 0);
});
test('D21 accounting preserves the optional contextRecords override', async t => {
  const w = world(t, { maxContextRecords: 1, contextRecords: () => 1 });
  assert.equal(w.internals.admissionCounts().contextRecords, 0);
  await assert.rejects(w.store.reservationAccounting.reserveAccounted(accountingInput(job(0x22), SELLER_CONTEXT_PATH)),
    { code: 'peer_context_capacity', status: 503 });
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n, 0);
});

test('D21 old-path reclamation cannot free the job slot still held by a K1 row', async t => {
  let terminal = false, retainedJob;
  const w = world(t, { maxJobs: 1, contextSessionState: ({ jobId }) => terminal && jobId === retainedJob ? 'finalised' : null });
  const { input } = w.prepare(); retainedJob = input.jobId;
  await w.admission.begin(input);
  const proposal = accountingInput(retainedJob, '/dacs/v1/agreements/proposals').payload;
  w.store.finish(w.store.reserve(proposal, {}, { keepProfile: PROFILE }), 200, '{}');
  terminal = true; w.control.clock += HOUR + 60001;
  w.reopen();
  const other = { ...accountingInput(job(0x22), proposal.path).payload, nonce: hash('other nonce') };
  assert.throws(() => w.store.reserve(other, {}, { keepProfile: PROFILE }), { code: 'peer_job_capacity', status: 503 });
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM peer_jobs').get().n, 1);
  assert.equal(w.internals.admissionCounts().contextRecords, 1);
});

test('D21 integration retains r31 payment-route transaction binding before any charge', async t => {
  const w = world(t), tx = hash('payment claim');
  const valid = accountingInput(job(0x22), '/dacs/v1/payments');
  const invalid = [
    { ...valid, checked: { body: { txHash: tx }, reserve: valid.checked.reserve } },
    { ...valid, paymentTx: tx },
    { ...valid, paymentTx: tx, checked: { body: { txHash: hash('other claim') }, reserve: valid.checked.reserve } },
    { ...accountingInput(job(0x22), SELLER_CONTEXT_PATH), paymentTx: tx },
  ];
  for (const input of invalid) {
    await assert.rejects(w.store.reservationAccounting.reserveAccounted(input), { code: 'wire_input_invalid', status: 500 });
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n, 0);
  }
  await w.store.reservationAccounting.reserveAccounted({ ...valid, paymentTx: '0x' + tx.toUpperCase(),
    checked: { body: { txHash: tx }, reserve: async () => ({ state: 'new' }) } });
  assert.equal(w.db.prepare('SELECT tx FROM kit_payment_transactions').get().tx, tx);
});
test('D21 integration retains P11b1L1 terminal retry binding through the accounting ledger', async t => {
  let terminal = false, view = null;
  const w = world(t, { contextSessionState: () => terminal ? 'finalised' : null, wireOperationView: () => view });
  const first = accountingInput(job(0x22), SELLER_CONTEXT_PATH);
  first.checked.reserve = async () => ({ state: 'new' });
  await w.store.reservationAccounting.reserveAccounted(first);
  terminal = true;
  view = { state: 'present', binding: wireOperationBinding(first.payload) };
  const retry = { ...first, payload: { ...first.payload, nonce: hash('retry nonce') } };
  await w.store.reservationAccounting.reserveAccounted(retry);
  const before = w.db.prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n;
  const different = { ...first, payload: { ...first.payload, nonce: hash('different nonce'), agreementHash: hash('different scope') } };
  await assert.rejects(w.store.reservationAccounting.reserveAccounted(different), { code: 'context_session_terminal', status: 409 });
  view = null;
  await assert.rejects(w.store.reservationAccounting.reserveAccounted({ ...first, payload: { ...first.payload, nonce: hash('missing view nonce') } }),
    { code: 'context_session_terminal', status: 409 });
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n, before);
});


test('R02 aborted K1 releases context after restart', async t => {
  const w = world(t, { maxContextRecords: 1 }), p = w.prepare();
  w.control.beforeReserve = () => { throw new Error('policy-refused'); };
  await reject(w.admission.begin(p.input), 'seller_budget_unavailable');
  await w.admission.sweep({ startup: false });
  assert.equal(w.row(p.input.jobId).state, 'aborted');
  w.reopen();
  assert.equal(w.internals.admissionCounts().contextRecords, 0);
  assert.equal(w.row(p.input.jobId).buyer, BUYER, 'abort retains ownership proof');
  w.control.beforeReserve = null;
  await w.admission.begin(w.prepare(0x22).input);
});

test('R03 aborted K1 releases job for old reserve after restart', async t => {
  const w = world(t, { maxJobs: 1 }), p = w.prepare();
  w.control.beforeReserve = () => { throw new Error('policy-refused'); };
  await reject(w.admission.begin(p.input), 'seller_budget_unavailable');
  await w.admission.sweep({ startup: false });
  assert.equal(w.row(p.input.jobId).state, 'aborted');
  w.control.clock += HOUR + 1; w.reopen();
  const request = accountingInput(job(0x22), '/dacs/v1/agreements/proposals').payload;
  assert.equal(w.store.reserve(request, {}, { keepProfile: PROFILE }).disposition, 'perform');
  assert.equal(w.row(p.input.jobId).state, 'aborted');
});

for (const [name, terminal, elapsed] of [
  ['R06 settled nonterminal retains both slots', false, HOUR + 1],
  ['R06 terminal inside start window retains both slots', true, HOUR - 1],
  ['R06 terminal retirement survives restart with unknown state', true, HOUR + 1],
]) test(name, async t => {
  let session = null;
  const w = world(t, { maxJobs: 1, maxContextRecords: 1, contextSessionState: () => session });
  const p = w.prepare(), next = w.prepare(0x22), capability = await running(w, p);
  await capability.complete(outcome);
  const proof = w.admission.admissionRecord(p.input.jobId);
  w.internals.transaction(() => w.internals.keepPurchaseProfileWithin(p.input.jobId, PROFILE));
  w.control.clock += elapsed; session = terminal ? 'finalised' : null;
  assert.equal(w.internals.admissionCounts().contextRecords, 1, 'counting alone cannot retire');
  await w.admission.sweep({ startup: false });
  if (!terminal || elapsed < HOUR) {
    assert.equal(w.internals.admissionCounts().contextRecords, 1);
    assert.deepEqual(w.store.purchaseProfile(p.input.jobId), PROFILE);
    await reject(w.admission.begin(next.input), 'peer_job_capacity', 503);
    const request = accountingInput(job(0x33), '/dacs/v1/agreements/proposals').payload;
    session = null;
    assert.throws(() => w.store.reserve(request, {}, { keepProfile: PROFILE }), { code: 'peer_job_capacity', status: 503 });
  } else {
    assert.equal(w.internals.admissionCounts().contextRecords, 0);
    assert.equal(w.store.purchaseProfile(p.input.jobId), null);
    assert.deepEqual(w.admission.admissionRecord(p.input.jobId), proof);
    session = null; w.reopen();
    assert.equal(w.internals.admissionCounts().contextRecords, 0);
    await w.admission.sweep({ startup: true });
    assert.equal(w.internals.admissionCounts().contextRecords, 0);
    assert.equal(w.store.purchaseProfile(p.input.jobId), null);
    assert.deepEqual(w.admission.admissionRecord(p.input.jobId), proof);
    await w.admission.begin(w.prepare(0x33).input);
    assert.equal(w.calls.reserve, 2, 'retirement and restart never repeat the first hold');
    assert.equal(w.internals.admissionCounts().contextRecords, 1);
  }
});

test('R06 retirement rollback preserves slots and restart can retry', async t => {
  let terminal = false;
  const w = world(t, { contextSessionState: () => terminal ? 'finalised' : null }), p = w.prepare();
  const capability = await running(w, p); await capability.complete(outcome);
  terminal = true; w.control.clock += HOUR + 1;
  assert.equal(typeof w.internals.retireSlotsWithin, 'function');
  assert.throws(() => w.internals.retireSlotsWithin(w.control.clock), /transaction/);
  w.db.exec("CREATE TRIGGER retirement_cut BEFORE INSERT ON kit_slot_retirements BEGIN SELECT RAISE(ABORT, 'retirement-cut'); END");
  await assert.rejects(w.admission.sweep({ startup: false }), /retirement-cut/);
  assert.equal(w.internals.admissionCounts().contextRecords, 1);
  w.reopen(); assert.equal(w.internals.admissionCounts().contextRecords, 1);
  w.db.exec('DROP TRIGGER retirement_cut');
  w.cut('before-commit', () => w.db.prepare('SELECT 1 FROM kit_slot_retirements WHERE job_retired = 1').get() !== undefined);
  await assert.rejects(w.admission.sweep({ startup: false }), /cut-before-commit/);
  assert.equal(w.internals.admissionCounts().contextRecords, 1);
  w.reopen(); assert.equal(w.internals.admissionCounts().contextRecords, 1);
  await w.admission.sweep({ startup: true });
  assert.equal(w.internals.admissionCounts().contextRecords, 0);
  assert.equal(w.row(p.input.jobId).state, 'settled');
});


test('R06 sweep retires current old-context holders without count-only subtraction', async t => {
  let terminal = false;
  const w = world(t, { maxContextRecords: 1, contextSessionState: () => terminal ? 'finalised' : null });
  const p = accountingInput(job(0x11), SELLER_CONTEXT_PATH).payload;
  w.store.finish(w.store.reserve(p, { scope: { jobId: p.jobId } }, { admit: () => w.control.clock }), 200, '{}');
  terminal = true; w.control.clock += HOUR + 1;
  assert.equal(w.internals.admissionCounts().contextRecords, 1, 'eligible rows still count before the writer commits');
  await w.admission.sweep({ startup: false });
  assert.equal(w.internals.admissionCounts().contextRecords, 0);
  terminal = false; w.reopen();
  assert.equal(w.internals.admissionCounts().contextRecords, 0);
  const foreign = accountingInput(job(0x11), '/dacs/v1/agreements/proposals', `did:demos:agent:${hash('foreign')}`).payload;
  assert.throws(() => w.store.reserve(foreign, {}, { keepProfile: PROFILE }), { code: 'peer_job_conflict', status: 409 });
});

test('R20 accounting adopts a detached tuple without another insert or timestamp change', async t => {
  const w = world(t, { maxJobs: 1 }), id = job(0x11), input = accountingInput(id, '/dacs/v1/agreements/proposals');
  w.internals.transaction(() => w.internals.keepPurchaseProfileWithin(id, PROFILE));
  w.db.exec("CREATE TRIGGER adoption_once BEFORE INSERT ON kit_purchase_profiles BEGIN SELECT RAISE(ABORT, 'second tuple insert'); END");
  input.checked = { body: {}, reserve: async () => ({ state: 'new' }) };
  w.control.clock++;
  const wrong = structuredClone(PROFILE); wrong.pinVersion += '-other';
  await assert.rejects(w.store.reservationAccounting.reserveAccounted({ ...input, keepProfile: wrong, payload: { ...input.payload, profile: wrong } }), { code: 'tp1_purchase_profile_mismatch', status: 500 });
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM peer_jobs').get().n, 0);
  assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n, 0);
  assert.equal((await w.store.reservationAccounting.reserveAccounted(input)).state, 'new');
  assert.equal(w.db.prepare('SELECT kept_at FROM kit_purchase_profiles WHERE job = ?').get(id).kept_at, T0);
  w.reopen(); assert.deepEqual(w.store.purchaseProfile(id), PROFILE);
});


test('R06 per-job retirement leaves another settled holder active', async t => {
  let terminal = false;
  const w = world(t, { contextSessionState: () => terminal ? 'finalised' : null });
  const a = w.prepare(0x11), b = w.prepare(0x22);
  await (await running(w, a)).complete(outcome);
  await (await running(w, b)).complete(outcome);
  terminal = true; w.control.clock += HOUR + 1;
  w.internals.transaction(() => w.internals.retireSlotsWithin(w.control.clock, a.input.jobId));
  assert.equal(w.internals.admissionCounts().contextRecords, 1);
  const flags = w.db.prepare('SELECT job_retired, context_retired FROM kit_slot_retirements WHERE job = ?').get(a.input.jobId);
  assert.deepEqual(flags, { job_retired: 1, context_retired: 1 });
  assert.equal(w.db.prepare('SELECT job FROM kit_slot_retirements WHERE job = ?').get(b.input.jobId), undefined);
  await w.admission.sweep({ startup: false });
  assert.equal(w.internals.admissionCounts().contextRecords, 0);
});


// Exercise the claiming boundaries against the same fresh-store contract.
const PROPOSALS = '/dacs/v1/agreements/proposals';
const claimPair = w => {
  const issued = [BUYER, OTHER].map(buyer => w.store.challenges.issue({ jobId: job(0x11), buyer }, hash('challenge-scope')));
  return [w.prepare(0x11, BUYER, { issued: issued[0] }), w.prepare(0x11, OTHER, { issued: issued[1] })];
};
const claimAt = (w, boundary, input, buyer = input.buyer) => {
  if (boundary === 'admission') return w.admission.begin(input);
  const args = accountingInput(input.jobId, PROPOSALS, buyer);
  args.payload.nonce = hash(input.jobId + buyer);
  if (boundary === 'old') return w.store.reserve(args.payload, {}, { keepProfile: PROFILE });
  return w.store.reservationAccounting.reserveAccounted({ ...args, checked: { body: {}, reserve: async () => ({ state: 'new' }) } });
};
const workSnapshot = w => Object.fromEntries(['peer_jobs', 'peer_effects', 'kit_context_admissions', 'kit_purchase_profiles', 'kit_job_holds', 'kit_reservations', 'kit_slot_retirements', 'kit_job_owners']
  .map(table => [table, w.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const ownerRow = (w, jobId) => w.db.prepare('SELECT * FROM kit_job_owners WHERE job = ?').get(jobId);

for (const first of ['old', 'admission', 'accounted']) for (const second of ['old', 'admission', 'accounted']) {
  test(`first committed ${first} claim excludes foreign ${second} without new work`, async t => {
    const w = world(t, { maxJobs: 1 }), [winner, loser] = claimPair(w);
    const results = await Promise.allSettled([Promise.resolve().then(() => claimAt(w, first, winner.input)),
      Promise.resolve().then(() => claimAt(w, second, loser.input))]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'peer_job_conflict'); assert.equal(results[1].reason.status, 409);
    const before = workSnapshot(w), calls = w.calls.reserve;
    await assert.rejects(Promise.resolve().then(() => claimAt(w, second, loser.input)), { code: second === 'admission' ? 'context_challenge_attempt_invalid' : 'peer_job_conflict' });
    assert.deepEqual(workSnapshot(w), before); assert.equal(w.calls.reserve, calls);
    assert.equal(ownerRow(w, winner.input.jobId).buyer, BUYER);
    for (const table of ['kit_context_admissions', 'kit_job_holds', 'kit_reservations']) assert.equal(w.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE buyer <> ?`).get(BUYER).n, 0);
    for (const [table, count] of [['peer_effects', Number(first === 'old')], ['kit_reservations', Number(first === 'accounted')], ['kit_purchase_profiles', Number(first !== 'admission')]]) {
      assert.equal(w.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, count);
    }
    assert.equal(w.calls.reserve, Number(first === 'admission'));
    if (second === 'admission') assert.equal(w.store.challenges.retained(loser.input.nonce).failure.code, 'peer_job_conflict');
    if (first !== 'admission') assert.equal(w.row(winner.input.jobId), null);
  });
}

for (const first of ['old', 'admission', 'accounted']) for (const second of ['old', 'admission', 'accounted']) {
  test(`maxJobs spans ${first} and ${second} claims`, async t => {
    const w = world(t, { maxJobs: 1 }), firstInput = w.prepare().input, next = w.prepare(0x22).input;
    await claimAt(w, first, firstInput);
    const before = workSnapshot(w), calls = w.calls.reserve;
    await assert.rejects(Promise.resolve().then(() => claimAt(w, second, next)), { code: 'peer_job_capacity', status: 503 });
    assert.deepEqual(workSnapshot(w), before); assert.equal(w.calls.reserve, calls);
    assert.equal(ownerRow(w, next.jobId), undefined);
    if (second === 'admission') assert.equal(w.store.challenges.retained(next.nonce).failure.code, 'peer_job_capacity');
    w.reopen(); assert.deepEqual(workSnapshot(w), before); assert.equal(ownerRow(w, next.jobId), undefined);
  });
}

test('refused INSERT rolls owner back and fails only the verified challenge', async t => {
  const w = world(t), p = w.prepare(), other = w.prepare(0x22), before = workSnapshot(w);
  const prepare = w.db.prepare.bind(w.db);
  w.db.prepare = sql => {
    if (sql.startsWith('INSERT INTO kit_context_admissions')) return { run() { throw Object.assign(new Error('definite-insert-refusal'), { code: 'peer_store_capacity', status: 503 }); } };
    return prepare(sql);
  };
  await assert.rejects(w.admission.begin(p.input), { code: 'peer_store_capacity', status: 503 });
  w.db.prepare = prepare;
  assert.equal(w.store.challenges.retained(p.input.nonce).failure.code, 'peer_store_capacity');
  assert.equal(w.store.challenges.retained(other.input.nonce).state, 'attempted');
  assert.deepEqual(workSnapshot(w), before); assert.equal(ownerRow(w, p.input.jobId), undefined); assert.equal(w.calls.reserve, 0);
  w.reopen(); assert.deepEqual(workSnapshot(w), before); assert.equal(ownerRow(w, p.input.jobId), undefined);
});

test('refused admission intent rolls retirement back across restart', async t => {
  let terminal = false;
  const w = world(t, { maxJobs: 1, contextSessionState: () => terminal ? 'finalised' : null }), p = w.prepare();
  const capability = await running(w, p); await capability.complete(outcome);
  w.control.clock += HOUR + 1;
  const next = w.prepare(0x22); terminal = true;
  const before = workSnapshot(w); w.control.ready = false;
  await assert.rejects(w.admission.begin(next.input), { code: 'seller_not_ready', status: 503 });
  assert.deepEqual(workSnapshot(w), before); assert.equal(ownerRow(w, next.input.jobId), undefined);
  w.reopen(); assert.deepEqual(workSnapshot(w), before); assert.equal(ownerRow(w, next.input.jobId), undefined);
  w.control.ready = true; terminal = false;
  await assert.rejects(w.admission.begin(w.prepare(0x33).input), { code: 'peer_job_capacity', status: 503 });
});

test('intent commit cuts preserve atomic ownership across restart', async t => {
  for (const at of ['before-commit', 'after-commit']) await t.test(at, async t => {
    const w = world(t), p = w.prepare();
    w.kill(() => w.row(p.input.jobId) !== null, at);
    await assert.rejects(w.admission.begin(p.input));
    w.reopen();
    assert.equal(Boolean(ownerRow(w, p.input.jobId)), at === 'after-commit');
    assert.equal(Boolean(w.row(p.input.jobId)), at === 'after-commit'); assert.equal(w.calls.reserve, 0);
    await w.admission.sweep({ startup: true });
    if (at === 'after-commit') { assert.equal(w.row(p.input.jobId).state, 'aborted'); assert.equal(ownerRow(w, p.input.jobId).closed, 1); }
    assert.equal(w.calls.reserve, 0); assert.equal(w.holds.size, 0);
  });
});

test('same nonce repeated begin writes nothing and keeps its live worker', async t => {
  const w = world(t), p = w.prepare(), gate = deferred(); w.control.beforeReserve = () => gate.promise.then(() => null);
  const pending = w.admission.begin(p.input); await flush(); const before = w.changes();
  try {
    await assert.rejects(w.admission.begin(p.input), { code: 'context_job_closed', status: 409 });
    assert.equal(w.changes(), before); assert.equal(owned(w, p.input.jobId, 1), true); assert.equal(w.calls.reserve, 1);
    assert.equal(w.store.challenges.retained(p.input.nonce).state, 'attempted');
  } finally { gate.resolve(); await pending; }
  assert.equal(w.row(p.input.jobId).state, 'admitted'); assert.equal(w.calls.reserve, 1);
});

for (const state of ['aborted', 'settled', 'retired']) test(`${state} admission keeps ownership before closure`, async t => {
  let terminal = false;
  const w = world(t, { contextSessionState: () => terminal ? 'finalised' : null }), [p, foreign] = claimPair(w);
  if (state === 'aborted') {
    w.control.beforeReserve = () => { throw new Error('policy-refused'); };
    await assert.rejects(w.admission.begin(p.input)); await w.admission.sweep({ startup: false });
  } else {
    const capability = await running(w, p); await capability.complete(outcome);
    if (state === 'retired') { terminal = true; w.control.clock += HOUR + 1; await w.admission.sweep({ startup: false }); }
  }
  const before = workSnapshot(w), calls = w.calls.reserve;
  await assert.rejects(w.admission.begin(foreign.input), { code: 'peer_job_conflict', status: 409 });
  assert.equal(w.store.challenges.retained(foreign.input.nonce).failure.code, 'peer_job_conflict');
  await assert.rejects(w.admission.begin(p.input), { code: 'context_job_closed', status: 409 });
  for (const boundary of ['old', 'accounted']) await assert.rejects(Promise.resolve().then(() => claimAt(w, boundary, foreign.input)), { code: 'peer_job_conflict', status: 409 });
  assert.deepEqual(workSnapshot(w), before); assert.equal(w.calls.reserve, calls); assert.equal(ownerRow(w, p.input.jobId).buyer, BUYER);
  if (state !== 'settled') assert.equal(ownerRow(w, p.input.jobId).closed, 1);
  w.reopen();
  assert.throws(() => w.internals.transaction(() => w.internals.reserveAdmissionWithin(foreign.input, w.control.clock)), { code: 'peer_job_conflict', status: 409 });
  for (const boundary of ['old', 'accounted']) await assert.rejects(Promise.resolve().then(() => claimAt(w, boundary, foreign.input)), { code: 'peer_job_conflict', status: 409 });
  assert.deepEqual(workSnapshot(w), before);
});

test('an existing context admission refuses another bootstrap and fails its challenge', async t => {
  const w = world(t), p = w.prepare(); w.legacyStart(0x11);
  const before = workSnapshot(w);
  await assert.rejects(w.admission.begin(p.input), { code: 'context_job_closed', status: 409 });
  assert.equal(w.store.challenges.retained(p.input.nonce).failure.code, 'context_job_closed');
  assert.deepEqual(workSnapshot(w), before); assert.equal(w.calls.reserve, 0); assert.equal(ownerRow(w, p.input.jobId), undefined);
});

test('effect authorized attempt cannot publish a clean null end', async t => {
  const w = world(t), p = w.prepare(), capability = await running(w, p);
  assert.equal(w.admission.runningCheck(p.input.jobId, capability.attempt, capability.rev), true);
  await assert.rejects(capability.complete(null), { code: 'context_admission_closed', status: 409 });
  assert.equal(w.calls.complete.length, 0); assert.equal(w.holds.size, 1);
});

test('old and accounted fresh nonce retries retain one job and one execution', async t => {
  for (const boundary of ['old', 'accounted']) await t.test(boundary, async t => {
    const w = world(t, { maxJobs: 1 }), p = w.prepare(), args = accountingInput(p.input.jobId, PROPOSALS);
    if (boundary === 'old') {
      const first = w.store.reserve(args.payload, {}, { keepProfile: PROFILE });
      w.store.finish(first, 200, '{}'); w.reopen();
      assert.equal(w.store.reserve({ ...args.payload, nonce: hash('retry') }, {}, { keepProfile: PROFILE }).disposition, 'cached');
      assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM peer_effects').get().n, 1);
    } else {
      let calls = 0;
      const checked = { body: {}, reserve: async () => ({ state: ++calls === 1 ? 'new' : 'completed' }) };
      await w.store.reservationAccounting.reserveAccounted({ ...args, checked });
      await assert.rejects(w.store.reservationAccounting.reserveAccounted({ ...args, checked }), { code: 'peer_request_replayed', status: 409 });
      assert.equal(calls, 1); assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM kit_reservations').get().n, 1); w.reopen();
      await w.store.reservationAccounting.reserveAccounted({ ...args, payload: { ...args.payload, nonce: hash('retry') }, checked });
      assert.equal(calls, 2); assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM kit_job_holds').get().n, 1);
    }
    assert.equal(w.db.prepare('SELECT COUNT(*) AS n FROM kit_job_owners').get().n, 1); assert.equal(ownerRow(w, p.input.jobId).buyer, BUYER);
  });
});


test('context capacity refuses admission without an owner or partial work', async t => {
  const w = world(t, { maxJobs: 2, maxContextRecords: 1 }), p = w.prepare(), next = w.prepare(0x22);
  await w.admission.begin(p.input); const before = workSnapshot(w);
  await assert.rejects(w.admission.begin(next.input), { code: 'peer_context_capacity', status: 503 });
  assert.deepEqual(workSnapshot(w), before); assert.equal(ownerRow(w, next.input.jobId), undefined); assert.equal(w.calls.reserve, 1);
  w.reopen(); assert.deepEqual(workSnapshot(w), before); assert.equal(ownerRow(w, next.input.jobId), undefined);
});

test('admission commits a feasible retirement and its new owner together', async t => {
  let terminal = false;
  const w = world(t, { maxJobs: 1, maxContextRecords: 1, contextSessionState: () => terminal ? 'finalised' : null }), p = w.prepare(), next = w.prepare(0x22);
  const capability = await running(w, p); await capability.complete(outcome); w.control.clock += HOUR + 1;
  terminal = true;
  await w.admission.begin(next.input);
  assert.equal(ownerRow(w, p.input.jobId).closed, 1); assert.equal(ownerRow(w, next.input.jobId).closed, 0);
  assert.equal(w.internals.admissionCounts().contextRecords, 1); assert.equal(w.calls.reserve, 2);
  w.reopen(); assert.equal(w.internals.admissionCounts().contextRecords, 1);
  assert.equal(w.row(p.input.jobId).state, 'settled'); assert.equal(w.row(next.input.jobId).state, 'admitted');
});

test('exact owner bytes and first purchase agreement survive restart', async t => {
  const w = world(t), p = w.prepare(); await w.admission.begin(p.input);
  assert.equal(ownerRow(w, p.input.jobId).agreement_hash, null);
  await claimAt(w, 'accounted', p.input);
  assert.equal(ownerRow(w, p.input.jobId).agreement_hash, hash('accounting agreement'));
  w.reopen(); const before = workSnapshot(w);
  for (const change of [{ buyer: OTHER }, { seller: OTHER }, { listingPin: { ...PIN, version: 2 } }, { agreementHash: hash('other agreement') }]) {
    const args = accountingInput(p.input.jobId, PROPOSALS); Object.assign(args.payload, change);
    args.operationId = wireOperationId(args.payload);
    assert.throws(() => w.store.reserve(args.payload, {}, { keepProfile: PROFILE }), { code: 'peer_job_conflict', status: 409 });
    await assert.rejects(w.store.reservationAccounting.reserveAccounted(args), { code: 'peer_job_conflict', status: 409 });
  }
  assert.throws(() => w.internals.transaction(() => w.internals.reserveAdmissionWithin({ ...p.input, buyer: EQUIVALENT_BUYER }, w.control.clock)), { code: 'peer_job_conflict', status: 409 });
  assert.deepEqual(workSnapshot(w), before);
});

test('an unverified attempt cannot fail either challenge or claim an owner', async t => {
  const w = world(t), p = w.prepare(), other = w.prepare(0x22), before = workSnapshot(w);
  await assert.rejects(w.admission.begin({ ...p.input, owner: other.input.owner }), { code: 'context_challenge_attempt_invalid', status: 409 });
  for (const input of [p.input, other.input]) { assert.equal(w.store.challenges.retained(input.nonce).state, 'attempted'); assert.equal(ownerRow(w, input.jobId), undefined); }
  assert.deepEqual(workSnapshot(w), before); assert.equal(w.calls.reserve, 0);
});

test('two store connections keep the first committed owner across restart', async t => {
  for (const first of ['old', 'admission', 'accounted']) await t.test(first, async t => {
    const w = world(t, { maxJobs: 1 }), p = w.prepare();
    let other = createSellerTransportStore({ path: join(w.directory, 'transport.sqlite'), maxJobs: 1, now: () => w.control.clock });
    t.after(() => other.close());
    const args = accountingInput(p.input.jobId, PROPOSALS, OTHER);
    const [winner, loser] = await Promise.allSettled([Promise.resolve().then(() => claimAt(w, first, p.input)),
      Promise.resolve().then(() => other.reservationAccounting.reserveAccounted(args))]);
    assert.equal(winner.status, 'fulfilled'); assert.equal(loser.status, 'rejected'); assert.equal(loser.reason.code, 'peer_job_conflict');
    const before = workSnapshot(w); other.close(); w.reopen();
    other = createSellerTransportStore({ path: join(w.directory, 'transport.sqlite'), maxJobs: 1, now: () => w.control.clock });
    assert.throws(() => other.reserve(args.payload, {}, { keepProfile: PROFILE }), { code: 'peer_job_conflict', status: 409 });
    assert.deepEqual(workSnapshot(w), before);
  });
});

test('SQL INSERT failure rolls back owner and retirement without failing a challenge', async t => {
  let terminal = false;
  const w = world(t, { maxJobs: 1, contextSessionState: () => terminal ? 'finalised' : null }), p = w.prepare(), next = w.prepare(0x22);
  const capability = await running(w, p); await capability.complete(outcome); w.control.clock += HOUR + 1; terminal = true;
  const before = workSnapshot(w);
  w.db.exec("CREATE TRIGGER admission_cut BEFORE INSERT ON kit_context_admissions BEGIN SELECT RAISE(ABORT, 'admission-cut'); END");
  await assert.rejects(w.admission.begin(next.input), /admission-cut/);
  assert.equal(w.store.challenges.retained(next.input.nonce).state, 'attempted');
  assert.deepEqual(workSnapshot(w), before); w.reopen(); assert.deepEqual(workSnapshot(w), before);
  assert.equal(w.calls.reserve, 1);
});


test('a definite operation_uncertain refusal commits only the owning challenge failure', async t => {
  const w = world(t, { capacity: { fitsNewPurchase() { throw Object.assign(new Error('definite'), { code: 'operation_uncertain', status: 503 }); }, allocateWithin() { assert.fail('refusal allocated'); } } });
  const p = w.prepare(), before = workSnapshot(w);
  await assert.rejects(w.admission.begin(p.input), { code: 'operation_uncertain', status: 503 });
  assert.equal(w.store.challenges.retained(p.input.nonce).failure.code, 'operation_uncertain');
  assert.deepEqual(workSnapshot(w), before); assert.equal(w.calls.reserve, 0);
});

for (const completion of ['finish', 'reconcile']) for (const restart of [false, true]) {
  test(`${completion} without effect allows a corrected Agreement for its buyer after restart=${restart}`, t => {
    const w = world(t), args = accountingInput(job(0x11), PROPOSALS);
    const first = w.store.reserve(args.payload, {}, { keepProfile: PROFILE });
    if (completion === 'finish') w.store.finish(first, 422, '{}', { noEffect: true });
    else {
      w.store.finish(first, 503, '{}');
      const retained = w.store.reserve({ ...args.payload, nonce: hash('reconciliation') }, {});
      w.store.reconcile(retained, args.payload, 422, '{}', { noEffect: true });
    }
    assert.equal(w.db.prepare('SELECT job FROM peer_jobs WHERE job = ?').get(args.payload.jobId), undefined);
    assert.equal(ownerRow(w, args.payload.jobId).agreement_hash, null);
    assert.equal(ownerRow(w, args.payload.jobId).closed, 0);
    if (restart) w.reopen();
    const corrected = { ...args.payload, nonce: hash('corrected proposal'), agreementHash: hash('corrected agreement') };
    const before = workSnapshot(w);
    assert.throws(() => w.store.reserve({ ...corrected, buyer: OTHER }, {}, { keepProfile: PROFILE }), { code: 'peer_job_conflict', status: 409 });
    assert.deepEqual(workSnapshot(w), before);
    const second = w.store.reserve(corrected, {}, { keepProfile: PROFILE });
    assert.equal(second.disposition, 'perform');
    assert.equal(ownerRow(w, corrected.jobId).agreement_hash, corrected.agreementHash);
    w.store.finish(second, 200, '{}'); w.reopen();
    assert.equal(w.store.reserve({ ...corrected, nonce: hash('completed retry') }, {}, { keepProfile: PROFILE }).disposition, 'cached');
    assert.throws(() => w.store.reserve({ ...args.payload, nonce: hash('refused agreement retry') }, {}, { keepProfile: PROFILE }), { code: 'peer_job_conflict', status: 409 });
  });
}

for (const boundary of ['old', 'accounted']) for (const source of ['rejecting promise', 'throw', 'non-state']) {
  test(`${boundary} proposal gate refuses a session source returning ${source} without work`, async t => {
    const cause = new Error('session unavailable'); let broken = false;
    const w = world(t, { contextSessionState: () => {
      if (!broken) return null;
      if (source === 'throw') throw cause;
      return source === 'rejecting promise' ? Promise.reject(cause) : 7;
    } });
    const args = accountingInput(job(0x11), PROPOSALS), before = workSnapshot(w);
    broken = true;
    const expected = { code: 'session_admission_unavailable', status: 503 };
    if (boundary === 'old') assert.throws(() => w.store.reserve(args.payload, {}, { keepProfile: PROFILE }), expected);
    else await assert.rejects(w.store.reservationAccounting.reserveAccounted(args), expected);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(workSnapshot(w), before); assert.equal(w.calls.reserve, 0);
  });
}

test('a purchase capacity refusal rolls back the retirement it observed across restart', async t => {
  let terminal = false, refuse = false, observed = false, w;
  const capacity = { fitsNewPurchase() {
    if (refuse) {
      assert.equal(ownerRow(w, job(0x11)).closed, 1);
      assert.equal(w.db.prepare('SELECT job_retired FROM kit_slot_retirements WHERE job = ?').get(job(0x11)).job_retired, 1);
      observed = true; return false;
    }
    return true;
  }, allocateWithin() {} };
  w = world(t, { maxJobs: 1, maxContextRecords: 1, capacity, contextSessionState: () => terminal ? 'finalised' : null });
  const p = w.prepare(), next = w.prepare(0x22);
  await (await running(w, p)).complete(outcome);
  w.control.clock += HOUR + 1; terminal = true; refuse = true;
  const before = workSnapshot(w);
  await assert.rejects(w.admission.begin(next.input), { code: 'seller_not_ready', status: 503 });
  assert.equal(observed, true); assert.deepEqual(workSnapshot(w), before);
  assert.equal(w.store.challenges.retained(next.input.nonce).failure.code, 'seller_not_ready');
  assert.equal(ownerRow(w, next.input.jobId), undefined); assert.equal(w.calls.reserve, 1);
  w.reopen(); assert.deepEqual(workSnapshot(w), before);
});

test('an aborted admission frees job and context capacity immediately and after restart', async t => {
  const w = world(t, { maxJobs: 1, maxContextRecords: 1 }), p = w.prepare();
  w.control.beforeReserve = () => 'budget-refused';
  await reject(w.admission.begin(p.input), 'seller_budget_refused', 409);
  await drained(w, p.input.jobId);
  assert.equal(w.row(p.input.jobId).state, 'aborted');
  for (const reopen of [false, true]) {
    if (reopen) w.reopen();
    assert.equal(w.internals.admissionCounts().contextRecords, 0);
    assert.equal(w.db.prepare("SELECT COUNT(*) AS n FROM kit_context_admissions WHERE state <> 'aborted'").get().n, 0);
    const request = accountingInput(job(0x22), '/dacs/v1/agreements/proposals').payload;
    assert.equal(w.store.classify(request, {}, { keepProfile: PROFILE }), 'start');
  }
  w.control.beforeReserve = null;
  await w.admission.begin(w.prepare(0x33).input);
});

test('failed and settled starts release both slots before a third start after restart', async t => {
  let terminal = false;
  const w = world(t, { maxJobs: 2, maxContextRecords: 2, contextSessionState: ({ jobId }) => terminal && jobId === job(0x11) ? 'finalised' : null });
  const settled = w.prepare(), failed = w.prepare(0x22), third = w.prepare(0x33);
  await (await running(w, settled)).complete(outcome);
  // Keep the failed start uncertain until the sweep proves it had no effect.
  w.control.inspect = () => ({ state: 'none' });
  w.control.evidence = record => w.evidenceOf(record, 'undetermined');
  w.control.beforeReserve = () => { throw new Error('policy-refused'); };
  await reject(w.admission.begin(failed.input), 'seller_budget_unavailable');
  await drained(w, failed.input.jobId);
  assert.equal(w.row(failed.input.jobId).state, 'compensating');
  await reject(w.admission.begin(third.input), 'peer_job_capacity', 503);
  w.control.evidence = null; w.control.beforeReserve = null;
  terminal = true; w.control.clock += HOUR + 61000;
  await w.admission.sweep({ startup: false });
  assert.equal(w.row(failed.input.jobId).state, 'aborted');
  assert.equal(w.row(settled.input.jobId).state, 'settled');
  assert.equal(w.internals.admissionCounts().contextRecords, 0);
  terminal = false; w.reopen();
  assert.equal(w.internals.admissionCounts().contextRecords, 0);
  await w.admission.begin(w.prepare(0x44).input);
  assert.equal(w.internals.admissionCounts().contextRecords, 1);
});
