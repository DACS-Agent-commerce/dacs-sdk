// P09ba: K1's admission transaction start (D2-D5), the fenced completion (D7/D8a-c), C1's CAS and the
// counter union. Policy, wire reservation and wire completion are doubles; P12b1 reruns the D5 cases on
// the real journal. The null-end fence case uses the real wire journal and so needs a root-owned `/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, compositeVerificationAddress, generateCanonicalJobId } from '@kynesyslabs/dacs';
import { TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION, inspectWireOperation, openWireRequestJournal,
  completeWireEffect, wireOperationBinding, wireOperationId } from '@kynesyslabs/dacs/wire';
import { journalStore, reserveEffect } from '../../../dist/wire/journal.js';
import { SELLER_PROFILE } from '../src/dacs/session-admission.mjs';
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
  const calls = { validation: 0, reserve: 0, release: 0, wire: 0, vet: 0, complete: [] };
  const control = { clock: T0, ready: true, beforeReserve: null, releaseFault: null, generation: 0, reserved: [] };
  const options = { maxContextRecords: 20, contextStartLimits: { maxStartsPerHour: 12, maxStartsPerBuyerPerHour: 5 }, ...config };
  const defaultPolicy = {
    async reserve(request) { calls.reserve++; control.reserved.push(request); holds.add(request.hold); return control.beforeReserve ? control.beforeReserve() : null; },
    async release({ hold }) { calls.release++; holds.delete(hold); if (control.releaseFault) throw control.releaseFault; },
  };
  const wire = { ends: new Map(), latest: -1 };
  const sameEnd = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const doubleCompleteWire = (effect, answer) => {
    if (effect.attempt !== wire.latest) throw Object.assign(new Error('superseded'), { code: 'seller_effect_superseded' });
    if (wire.ends.has(effect.attempt) && !sameEnd(wire.ends.get(effect.attempt), answer)) throw Object.assign(new Error('conflict'), { code: 'seller_effect_conflict' });
    calls.complete.push({ effect, outcome: answer }); wire.ends.set(effect.attempt, answer);
  };
  let store, admission, internals;
  function reopen() {
    store?.close();
    store = createSellerTransportStore({ path, generation: `test-generation-${++control.generation}`, now: () => control.clock, ready: () => control.ready,
      maxContextRecords: options.maxContextRecords, contextStartLimits: options.contextStartLimits });
    internals = sellerStoreInternals(store);
    admission = createContextAdmissionTransaction({ store, policy: options.policy ?? defaultPolicy, capacity: options.capacity ?? null,
      effectEvidence: async () => [], inspectContextOutcome: () => ({ state: 'none' }), completeWire: options.completeWire ?? doubleCompleteWire,
      now: () => control.clock, ready: () => control.ready, deadlines: { policyMs: POLICY_MS } });
  }
  reopen();
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  function prepare(index = 0x11, buyer = BUYER, { presenter = buyer } = {}) {
    const jobId = job(index), challengeScopeHash = hash('challenge-scope');
    const { sessionNonce: nonce } = store.challenges.issue({ jobId, buyer }, challengeScopeHash);
    const bundle = { presentedBy: presenter, sessionNonce: nonce, presentation: { proof: 'TEST-fixture' } };
    const attempt = { nonce, jobId, buyer, challengeScopeHash, presentationHash: hash(canonicalize(bundle)), path: 'context' };
    const result = store.challenges.attempt(attempt); assert.equal(result.kind, 'validate'); calls.validation++;
    const accepted = { buyerBundleText: ' ' + JSON.stringify(bundle) + ' ', buyerBundleHash: hash('bundle'), admission: {
      disposition: 'admitted', jobId, buyer, buyerBundleHash: hash('bundle'), listingPin: PIN,
      participants: [{ role: 'buyer', claim: buyer, ...SELLER_PROFILE }, { role: 'seller', claim: SELLER, ...SELLER_PROFILE }] },
      firstAdmission: { challengeExpiresAt: control.clock + 600000, generatedAt: control.clock, checkedAt: control.clock } };
    const input = { jobId, buyer, seller: SELLER, listingPin: PIN, contextScopeHash: hash('context-scope'), nonce, presentationHash: attempt.presentationHash,
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
  return { directory, holds, calls, wire, control, options, prepare, reserveWire, legacyStart, row, compensating, cut, reopen, wireEnds: wire.ends,
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
  assert.equal(settled.state, 'settled'); assert.equal(settled.contextOutcome, null);
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
  assert.equal(w.row(p.input.jobId).state, 'compensating'); assert.equal(openHolds(evidencePath), 0);
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
  refused.reopen(); assert.equal(refused.row(p.input.jobId).state, 'compensating'); assert.equal(refused.row(p.input.jobId).admittedAt, null);
  assert.equal(refused.store.challenges.retained(p.input.nonce).state, 'failed'); assert.equal(refused.holds.size, 1); assert.equal(refused.calls.release, 0);
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
  assert.deepEqual(unhandled, []); assert.equal(w.row(p.input.jobId).state, 'compensating'); assert.equal(w.row(p.input.jobId).admittedAt, null);
  assert.equal(w.store.challenges.retained(p.input.nonce).failure.code, 'operation_uncertain'); assert.equal(w.holds.size, 1);
  const faulty = world(t), q = faulty.prepare(); faulty.cut('before-commit', () => faulty.row(q.input.jobId)?.state === 'admitted');
  await assert.rejects(faulty.admission.begin(q.input), /cut-before-commit/);
  assert.equal(faulty.row(q.input.jobId).state, 'compensating'); assert.equal(faulty.holds.size, 1); assert.equal(faulty.calls.release, 0);
  const refused = world(t), r = refused.prepare(), capability = await running(refused, r); refused.wire.latest++;
  await reject(capability.complete(outcome), 'seller_effect_superseded');
  assert.equal(refused.row(r.input.jobId).state, 'running'); assert.equal(refused.calls.release, 0); assert.equal(refused.calls.complete.length, 0);
  assert.throws(() => refused.internals.transaction(() => refused.admission.runningCheck(r.input.jobId, capability.attempt, capability.rev)), TypeError);
});

test('admission-capability-identity', async t => {
  const w = world(t), p = w.prepare(); const a = await running(w, p);
  assert.deepEqual(Object.keys(w.admission).sort(), ['addAcceptanceHook', 'begin', 'jobEffectMutex', 'reserveContext', 'runningCheck']);
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
  await reject(w.admission.begin({ ...p.input, buyer: EQUIVALENT_BUYER }), 'context_job_closed', 409);
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
  assert.equal(owned(w, a.input.jobId, 1), false); assert.equal(w.row(a.input.jobId).state, 'compensating');
});
