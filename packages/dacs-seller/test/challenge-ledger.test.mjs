// The challenge ledger's state machine on real SQLite files. Everything is derived at run time
// (hashes, claims, jobs, nonces) and the clock is injected. Run through `npm run seller:test`,
// which loads the kit-guard fixture; the guard is admitted there and switched off where a test says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { canonicalize, generateCanonicalJobId, identityBundleHash, sameCanonicalClaimIdentity, sha256Hex } from '@kynesyslabs/dacs';
import { CHALLENGE_LIMIT_DEFAULTS, createSellerChallengeLedger } from '../src/dacs/seller-challenge-ledger.mjs';
import { SELLER_PROFILE } from '../src/dacs/session-admission.mjs';

const TITLES = {
  T01: 'issue returns a fresh 64-hex nonce expiring 600,000 ms after issue',
  T02: 'the same job, buyer and scope inside the lifetime returns the same nonce with zero writes',
  T03: 'an expired unattempted challenge is replaced by a new issuance that counts against the hour; the 17th for one job is refused',
  T04: "a buyer's sixth issuance in the hour is refused with zero mutations, and admitted again at exactly one hour",
  T05: 'five, five and two issuances exhaust the overall hour; a fourth buyer is refused with zero writes',
  T06: 'a refusal at each of steps 7–15 executes no INSERT, UPDATE or DELETE at this PR; after P11b2c installs the observer, assert zero challenge/admission/hold/new-allocation/reservation mutations, counting terminal closure and eligible allocation cleanup separately (T25, H11-6)',
  T07: 'full start counts refuse issuance with `unpaid_start_limit`, then `buyer_unpaid_start_limit`',
  T08: 'table: candidate row state (`issued`, `attempted`, `accepted`, `failed`) × expiry (before, exactly at, after now) × issued age (just under, exactly, over one hour) × normalized `sessionState` (terminal, nonterminal, unknown, throws). At `maxChallenges`, issue for a different open job with other limits nonbinding: reclaim the candidate exactly when `expiresAt ≤ now`, `issuedAt ≤ now − 3600000` and terminal, regardless of row state; delete once and insert the new row. Every other cell retains the candidate and refuses `context_challenge_capacity` with zero writes at this PR. A throwing source is normalized to unknown (SA-18); after P11b2c, count closure/eligible cleanup metadata separately from challenge/new-work mutations',
  T09: 'a full context-record count refuses with `peer_context_capacity` and zero challenge/new-work writes; after P11b2c installs the observer, count terminal-observation metadata separately (SA-18)',
  T10: 'an unsafe clock or an unsafe expiry sum refuses with `peer_clock_invalid` before any ledger access',
  T11: 'stop requested or guard off at step 16 refuses with zero writes',
  T12: 'the first attempt records `attempted` with its owner in the same transaction before it returns `validate`',
  T13: 'table: entry (`issue`/`issueForOperator`, first `attempt`, accepted continuation, caller use of `retained(nonce)`) × party/input (same buyer, other buyer, canonical-equivalent buyer with advisory parameters, other complete bundle/presentation hash, other job or scope) × live/reopened store. Same or canonical-equivalent buyer reuses an issued nonce and can first-attempt; accepted continuation requires the exact complete bundle and original admission, remains valid after expiry, and writes nothing. On a first attempt a different job, buyer or scope fails once as `context_challenge_mismatch`; the identical retry is `context_challenge_failed` with that cause. Another bundle on an accepted nonce is `context_challenge_consumed`. For an accepted job with a nonterminal session, new issuance for the same, equivalent or another buyer is always `context_job_closed` with zero writes, also after reopening; a terminal session answers `context_session_terminal` first (K1 step 7). `retained` itself is nonce-only and read-only; its caller applies the shared buyer comparison and exact retained-bundle check, accepting equivalent buyer arguments but refusing another buyer/job/bundle. Preserve the complete retained bytes across restart; proposal integration is P09a2-T03',
  T15: 'table: entries (`issue`, `issueForOperator`, `attempt`, `accept`, `recordFailed`) × each field that entry actually accepts (nonce, job, buyer, scope hash, presentation hash, including accepted-record fields) × missing, null, wrong type, wrong length, uppercase and `{}`; include an empty issuance request. Inapplicable entry/field pairs are marked N/A, never invented arguments. Direct issuance rejects job errors as `peer_job_invalid`, buyer/scope errors as `context_scope_invalid`, with zero ledger access, writes or rows; operator issuance has no scope hash. Malformed/uppercase and unknown nonces at attempt refuse `context_challenge_mismatch` with zero writes. With an otherwise matching live `issued` nonce, bad job/buyer/scope records `failed{context_challenge_mismatch}` once; null or malformed present presentation hash (`"bad"`, wrong length, uppercase, number) records `failed{context_challenge_attempt_invalid}` once and answers that code; a subsequent different valid presentation is `context_challenge_consumed`, with no validation. Malformed accept records refuse `context_challenge_attempt_invalid` before mutation; accept/fail with invalid nonce or owner change nothing (T22). Assert the code, status, exact row state and SQL count for each applicable cell',
  T16: 'an attempt one millisecond before expiry validates; one at expiry fails as expired',
  T18: 'the identical presentation during validation is pending with zero writes; another presentation is consumed',
  T19: 'a recorded validation refusal answers `context_challenge_failed` with its cause, and closes the job to new challenges',
  T20: 'startup closes only earlier-generation attempts as `validator_lost`; accepted and failed rows are untouched',
  T22: 'accept or recordFailed by a non-owner, or on a row not attempted, changes nothing; no row returns to `issued`',
  T23: 'two processes on one store issue for the last overall slot: one is issued and one refused, rows +1',
  T24: 'two connections attempting the identical presentation produce exactly one owner',
  T25: 'while not ready, an attempt that would reach step 7 answers `seller_not_ready` with no write',
  T26: 'an accepted row missing its bundle text or admission answers `session_admission_unavailable` on continuation',
  T27: 'an operator row is consumed as a mismatch on the context path; a route row is never first-admitted on the proposal path',
  T28: 'a ledger-level issuance makes exactly one insertion and no journal file',
};
const cardTest = (id, run) => test(`P09a1-${id} ${TITLES[id]}`, run);

const T0 = Date.UTC(2026, 9, 27, 12);
const HOUR = 3_600_000;
const LIFETIME = 600_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const hash = (label) => createHash('sha256').update(String(label)).digest('hex');
const job = (label) => generateCanonicalJobId({ timestamp: T0, entropy: createHash('sha256').update(String(label)).digest().subarray(0, 10) });
const claim = (label) => `did:demos:agent:${hash(`claim ${label}`)}`;
const BUYER = claim('buyer');
const SELLER = claim('seller');
const OTHER = claim('other buyer');
const EQUIVALENT = `${BUYER}?jurisdiction=GB`;
const SCOPE = hash('scope');
// The presentation a nonce is attempted with: its canonical bytes, and the hash and bundle hash callers derive from them.
const bundleFor = (nonce, buyer = BUYER, presentation = 'fixture') => ({ presentedBy: buyer, sessionNonce: nonce, presentation: { kind: presentation } });
const presentationOf = (nonce, buyer, presentation) => sha256Hex(canonicalize(bundleFor(nonce, buyer, presentation)));
const PIN = { listingId: 'listing', version: 1, contentHash: hash('listing') };
const PROFILE = { standardRevision: SELLER_PROFILE.standardRevision, documentVersions: SELLER_PROFILE.documentVersions };
const LIVE = { assertStillLive() {} };
const MUTATION = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;
const guard = await import('../src/kit-operation-guard.mjs');

function world(t, { limits = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'challenge-ledger-'));
  const path = join(directory, 'store.sqlite');
  const control = { now: T0, fault: null, sessionState: () => null, ready: true, stopped: false, ports: 0, countReads: 0, counts: { contextRecords: 0, starts: 0, buyerStarts: 0 } };
  const statements = [];
  const handles = [];
  let current;

  function connect(generation) {
    const db = new Database(path, { verbose: (sql) => statements.push(sql) });
    handles.push(db);
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    const transaction = (run) => {
      db.exec('BEGIN IMMEDIATE');
      let committed = false;
      try {
        const result = run();
        if (control.fault === 'before-commit') throw new Error('cut before commit');
        db.exec('COMMIT');
        committed = true;
        if (control.fault === 'after-commit') throw new Error('cut after commit');
        return result;
      } catch (error) {
        if (!committed) db.exec('ROLLBACK');
        throw error;
      }
    };
    const ledger = createSellerChallengeLedger({
      db, transaction, generation, limits, now: () => control.now,
      sessionState: ({ jobId }) => { control.ports++; return control.sessionState(jobId); },
      admissionCounts: () => { control.ports++; control.countReads++; return { contextRecords: control.counts.contextRecords, starts: control.counts.starts, buyerStarts: () => control.counts.buyerStarts }; },
      ready: () => control.ready,
      stopped: () => control.stopped,
    });
    statements.length = 0;
    return { db, ledger };
  }
  function reopen(generation = 'generation-one') {
    if (current?.db.open) current.db.close();
    current = connect(generation);
  }
  reopen();
  t.after(() => { for (const db of handles) if (db.open) db.close(); rmSync(directory, { recursive: true, force: true }); });

  const input = (nonce, overrides = {}) => ({ nonce, jobId: job('one'), buyer: BUYER, challengeScopeHash: SCOPE, presentationHash: presentationOf(nonce), path: 'context', ...overrides });
  const w = {
    path, directory, control, statements, connect, reopen,
    get ledger() { return current.ledger; },
    get db() { return current.db; },
    mutations: () => statements.filter((sql) => MUTATION.test(sql)),
    rows: () => current.db.prepare('SELECT * FROM kit_challenges ORDER BY nonce').all(),
    issue: (label = 'one', buyer = BUYER, scope = SCOPE) => current.ledger.issue({ jobId: job(label), buyer }, scope, LIVE),
    input,
    attempt: (nonce, overrides) => current.ledger.attempt(input(nonce, overrides)),
    // The accepted record of the presentation `bundle` (default: the one `input` attempts with), shaped as a caller stores it.
    record(nonce, label = 'one', buyer = BUYER, bundle = bundleFor(nonce, buyer)) {
      const bundleHash = identityBundleHash(bundle);
      const admission = { disposition: 'admitted', jobId: job(label), buyer: bundle.presentedBy, buyerBundleHash: bundleHash, listingPin: PIN,
        participants: [{ role: 'buyer', claim: bundle.presentedBy, ...PROFILE }, { role: 'seller', claim: SELLER, ...PROFILE }] };
      return { buyerBundleText: canonicalize(bundle), buyerBundleHash: bundleHash, admission, admittedAt: control.now,
        firstAdmission: { challengeExpiresAt: current.ledger.retained(nonce).expiresAt, generatedAt: T0, checkedAt: control.now } };
    },
    // Runs `run` and proves it executed no INSERT, UPDATE or DELETE.
    quiet(run) {
      statements.length = 0;
      const result = run();
      assert.deepEqual(w.mutations(), []);
      return result;
    },
    attempted(label = 'one') {
      const { sessionNonce } = w.issue(label);
      return { nonce: sessionNonce, owner: w.attempt(sessionNonce, { jobId: job(label) }).owner };
    },
    accepted(label = 'one') {
      const { nonce, owner } = w.attempted(label);
      const record = w.record(nonce, label);
      assert.equal(current.ledger.accept(owner, nonce, record), true);
      return { nonce, owner, record };
    },
  };
  return w;
}

const refusal = (run, code, status = 409) => assert.throws(run, { code, status });
const refused = (code, status = 409, cause) => ({ kind: 'refused', code, status, ...(cause ? { cause } : {}) });
const quietRefusal = (w, run, code, status) => w.quiet(() => refusal(run, code, status));

cardTest('T01', (t) => {
  const w = world(t);
  const answer = w.issue();
  assert.match(answer.sessionNonce, /^[0-9a-f]{64}$/);
  assert.equal(answer.expiresAt, T0 + LIFETIME);
  assert.deepEqual(Object.keys(answer).sort(), ['expiresAt', 'sessionNonce']);
  assert.equal(w.ledger.retained(answer.sessionNonce).origin, 'route');
  assert.notEqual(w.issue('two').sessionNonce, answer.sessionNonce);
  refusal(() => w.ledger.issue({ jobId: job('three'), buyer: BUYER, nonce: hash('supplied') }, SCOPE, LIVE), 'context_scope_invalid');
  assert.equal(w.rows().length, 2);
});

cardTest('T02', (t) => {
  const w = world(t);
  const first = w.issue();
  w.control.now = T0 + 1000;
  assert.deepEqual(w.quiet(() => w.issue()), first);
});

cardTest('T03', (t) => {
  const w = world(t, { limits: { maxPerHour: 100, maxPerBuyerPerHour: 100 } });
  const nonces = new Set();
  for (let i = 0; i < 16; i++) {
    w.control.now = T0 + i * LIFETIME;
    nonces.add(w.issue().sessionNonce);
  }
  assert.equal(nonces.size, 16);
  assert.equal(w.rows().length, 16);
  w.control.now = T0 + 16 * LIFETIME;
  quietRefusal(w, () => w.issue(), 'context_challenge_capacity', 503);
  assert.equal(w.rows().length, 16);

  const hourly = world(t, { limits: { maxPerBuyerPerHour: 2 } });
  hourly.issue();
  hourly.control.now = T0 + LIFETIME;
  hourly.issue();
  hourly.control.now = T0 + 2 * LIFETIME;
  quietRefusal(hourly, () => hourly.issue(), 'buyer_context_challenge_limit', 429);
});

cardTest('T04', (t) => {
  const w = world(t);
  for (let i = 0; i < 5; i++) w.issue(i);
  w.control.now = T0 + HOUR - 1;
  quietRefusal(w, () => w.issue(5), 'buyer_context_challenge_limit', 429);
  w.control.now = T0 + HOUR;
  assert.match(w.issue(5).sessionNonce, /^[0-9a-f]{64}$/);
  assert.equal(w.rows().length, 6);
});

cardTest('T05', (t) => {
  const w = world(t);
  let index = 0;
  for (const [buyer, count] of [[BUYER, 5], [OTHER, 5], [SELLER, 2]]) for (let i = 0; i < count; i++) w.issue(index++, buyer);
  quietRefusal(w, () => w.issue('last', claim('fourth')), 'context_challenge_limit', 429);
  assert.equal(w.rows().length, 12);
});

cardTest('T06', (t) => {
  // Step 9 is a read-only success (T02); every other step from 7 to 15 refuses.
  const steps = [
    [7, {}, (w) => { w.control.sessionState = () => 'finalised'; }, 'context_session_terminal', 409],
    [8, {}, (w) => w.accepted(), 'context_job_closed', 409],
    [10, { maxPerHour: 1 }, (w) => w.issue('earlier'), 'context_challenge_limit', 429],
    [11, { maxPerBuyerPerHour: 1 }, (w) => w.issue('earlier'), 'buyer_context_challenge_limit', 429],
    [12, { maxPerJob: 1 }, (w) => { w.issue(); w.control.now = T0 + LIFETIME; }, 'context_challenge_capacity', 503],
    [13, { maxChallenges: 1 }, (w) => { w.issue('earlier'); w.control.now = T0 + HOUR; }, 'context_challenge_capacity', 503],
    [14, { maxContextRecords: 1 }, (w) => { w.control.counts.contextRecords = 1; }, 'peer_context_capacity', 503],
    [15, {}, (w) => { w.control.counts.starts = CHALLENGE_LIMIT_DEFAULTS.maxStartsPerHour; }, 'unpaid_start_limit', 429],
  ];
  for (const [step, limits, setup, code, status] of steps) {
    const w = world(t, { limits });
    setup(w);
    const before = w.rows();
    quietRefusal(w, () => w.issue(), code, status);
    assert.deepEqual(w.rows(), before, `step ${step} left the ledger unchanged`);
  }
});

cardTest('T07', (t) => {
  const w = world(t);
  w.control.counts.starts = 12;
  w.control.counts.buyerStarts = 5;
  quietRefusal(w, () => w.issue(), 'unpaid_start_limit', 429);
  w.control.counts.starts = 11;
  quietRefusal(w, () => w.issue(), 'buyer_unpaid_start_limit', 429);
  w.control.counts.buyerStarts = 4;
  assert.ok(w.issue().sessionNonce);
});

cardTest('T08', (t) => {
  const sources = {
    terminal: () => 'finalised',
    nonterminal: () => 'negotiating',
    unknown: () => null,
    throws: () => { throw new Error('source unavailable'); },
  };
  // Not strings, or not synchronous: also unknown, and a rejected promise must not escape as an unhandled rejection.
  const unusable = {
    promise: () => Promise.resolve('finalised'),
    'rejected promise': () => Promise.reject(new Error('late')),
    object: () => ({ state: 'finalised' }),
    number: () => 42,
  };
  // Only a source that answers a terminal state for the candidate can reclaim it.
  const cell = (state, expiry, age, source) => {
    const w = world(t, { limits: { maxChallenges: 1 } });
    const candidate = w.issue('candidate').sessionNonce;
    w.control.now = T0 + 2 * HOUR;
    w.db.prepare('UPDATE kit_challenges SET state = ?, expiresAt = ?, issuedAt = ?').run(state, w.control.now + expiry, w.control.now - HOUR - age);
    w.control.sessionState = (jobId) => (jobId === job('candidate') ? { ...sources, ...unusable }[source]() : null);
    const before = w.rows();
    const reclaims = expiry <= 0 && age >= 0 && source === 'terminal';
    if (!reclaims) {
      quietRefusal(w, () => w.issue('new'), 'context_challenge_capacity', 503);
      assert.deepEqual(w.rows(), before, `${state} ${expiry} ${age} ${source} retained`);
      return;
    }
    w.statements.length = 0;
    w.issue('new');
    assert.equal(w.statements.filter((sql) => /^\s*DELETE\b/i.test(sql)).length, 1);
    assert.equal(w.statements.filter((sql) => /^\s*INSERT\b/i.test(sql)).length, 1);
    assert.equal(w.ledger.retained(candidate), null);
    assert.equal(w.rows().length, 1);
  };
  for (const state of ['issued', 'attempted', 'accepted', 'failed']) for (const expiry of [-1, 0, 1]) for (const age of [-1, 0, 1]) for (const source of Object.keys(sources)) cell(state, expiry, age, source);
  for (const source of Object.keys(unusable)) cell('issued', 0, 0, source);
});

cardTest('T09', (t) => {
  const w = world(t);
  w.control.counts.contextRecords = CHALLENGE_LIMIT_DEFAULTS.maxContextRecords;
  quietRefusal(w, () => w.issue(), 'peer_context_capacity', 503);
});

cardTest('T10', (t) => {
  const w = world(t);
  const unsafe = [-1, NaN, Infinity, 1.5, '1', MAX_SAFE + 1, MAX_SAFE - LIFETIME + 1, MAX_SAFE - 1];
  for (const time of unsafe) {
    w.control.now = time;
    w.statements.length = 0;
    refusal(() => w.issue(), 'peer_clock_invalid', 503);
    refusal(() => w.ledger.issueForOperator({ jobId: job('one'), buyer: BUYER }), 'peer_clock_invalid', 503);
    assert.deepEqual(w.statements, [], `no ledger access at ${String(time)}`);
  }
  for (const time of [-1, NaN, MAX_SAFE + 1]) {
    w.control.now = time;
    w.statements.length = 0;
    refusal(() => w.attempt(hash('unknown')), 'peer_clock_invalid', 503);
    assert.deepEqual(w.statements, []);
  }
  assert.equal(w.control.ports, 0);
  w.control.now = MAX_SAFE - LIFETIME;
  assert.equal(w.issue().expiresAt, MAX_SAFE);
  assert.equal(w.rows().length, 1);
});

cardTest('T11', (t) => {
  const stopped = world(t);
  stopped.control.stopped = true;
  quietRefusal(stopped, () => stopped.issue(), 'seller_stopped', 503);
  quietRefusal(stopped, () => stopped.ledger.issueForOperator({ jobId: job('one'), buyer: BUYER }), 'seller_stopped', 503);

  // The guard goes off after the entry check, while the counts are read (before step 16).
  const switched = world(t);
  const counts = switched.control.counts;
  Object.defineProperty(counts, 'contextRecords', { get() { guard.setKitOperationGuardForTest('off'); return 0; } });
  try {
    switched.quiet(() => assert.throws(() => switched.issue(), { code: 'kit_operation_guard_off', name: 'KitOperationGuardError' }));
  } finally { guard.setKitOperationGuardForTest('testnet-tp1'); }

  // With the shipped constant (no fixture loader) both issue entries refuse before any callback or row.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import Database from 'better-sqlite3';
    import { createSellerChallengeLedger } from './packages/dacs-seller/src/dacs/seller-challenge-ledger.mjs';
    const db = new Database(':memory:');
    const never = (name) => () => assert.fail(name);
    const ledger = createSellerChallengeLedger({ db, transaction: never('transaction'), now: never('clock'), generation: 'off',
      sessionState: never('observation'), admissionCounts: never('counts'), ready: never('ready'), stopped: never('stopped') });
    for (const entry of ['issue', 'issueForOperator']) assert.throws(() => ledger[entry](), { code: 'kit_operation_guard_off', entry });
    assert.equal(db.prepare('SELECT count(*) AS n FROM kit_challenges').get().n, 0);
  `], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
});

cardTest('T12', (t) => {
  const w = world(t);
  const { sessionNonce } = w.issue();
  w.statements.length = 0;
  const result = w.attempt(sessionNonce);
  assert.equal(result.kind, 'validate');
  assert.equal(result.owner.generation, 'generation-one');
  assert.match(result.owner.attemptId, /^[0-9a-f-]{36}$/);
  const row = w.ledger.retained(sessionNonce);
  assert.deepEqual({ state: row.state, owner: row.owner, attemptedAt: row.attemptedAt, presentationHash: row.presentationHash }, { state: 'attempted', owner: result.owner, attemptedAt: T0, presentationHash: presentationOf(sessionNonce) });
  const update = w.statements.findIndex((sql) => /^\s*UPDATE\b/i.test(sql));
  assert.ok(w.statements.indexOf('BEGIN IMMEDIATE') < update && update < w.statements.indexOf('COMMIT'));
});

cardTest('T13', (t) => {
  for (const reopened of [false, true]) for (const operator of [false, true]) {
    const label = `${operator ? 'operator' : 'route'} ${reopened ? 'reopened' : 'live'}`;
    const w = world(t);
    const issue = (buyer) => (operator ? w.ledger.issueForOperator({ jobId: job('one'), buyer }) : w.issue('one', buyer));
    const route = operator ? { path: 'proposal', challengeScopeHash: null } : { path: 'context', challengeScopeHash: SCOPE };
    const first = issue(BUYER);
    if (reopened) w.reopen();
    assert.deepEqual(w.quiet(() => issue(EQUIVALENT)), first, `${label}: an equivalent buyer reuses the nonce`);
    assert.equal(w.ledger.retained(first.sessionNonce).buyer, BUYER, 'the stored buyer is never rewritten');
    const { owner } = w.attempt(first.sessionNonce, { ...route, buyer: EQUIVALENT });
    assert.ok(owner, `${label}: an equivalent buyer can first-attempt`);
    const record = w.record(first.sessionNonce);
    assert.equal(w.ledger.accept(owner, first.sessionNonce, record), true);

    w.control.now = T0 + LIFETIME + 1;
    if (reopened) w.reopen('generation-two');
    for (const buyer of [BUYER, EQUIVALENT]) assert.deepEqual(w.quiet(() => w.attempt(first.sessionNonce, { ...route, buyer })), { kind: 'continuation', accepted: record }, label);
    // The one other path: the proposal continues a route row's context-step acceptance, read only. An operator row has none.
    const otherPath = { path: operator ? 'context' : 'proposal' };
    const answerOnOtherPath = operator ? refused('context_challenge_consumed') : { kind: 'continuation', accepted: record };
    for (const buyer of [BUYER, EQUIVALENT]) assert.deepEqual(w.quiet(() => w.attempt(first.sessionNonce, { ...route, ...otherPath, buyer })), answerOnOtherPath, `${label} other path`);
    for (const change of [{ buyer: OTHER }, { jobId: job('other') }, { challengeScopeHash: hash('other scope') }, { presentationHash: hash('other bundle') }]) {
      for (const path of [route.path, otherPath.path]) {
        assert.deepEqual(w.quiet(() => w.attempt(first.sessionNonce, { ...route, ...change, path })), refused('context_challenge_consumed'), `${label} ${path} ${Object.keys(change)}`);
      }
    }
    for (const buyer of [BUYER, EQUIVALENT, OTHER]) quietRefusal(w, () => issue(buyer), 'context_job_closed', 409);
    w.control.sessionState = () => 'finalised';
    for (const buyer of [BUYER, OTHER]) quietRefusal(w, () => issue(buyer), 'context_session_terminal', 409);
    w.control.sessionState = () => null;

    // `retained` takes the nonce only and reads only; the caller compares the buyer and the exact bundle bytes.
    const retained = w.quiet(() => w.ledger.retained(first.sessionNonce));
    assert.equal(w.ledger.retained.length, 1);
    assert.equal(retained.accepted.buyerBundleText, record.buyerBundleText, 'the complete bundle bytes survive');
    assert.deepEqual([EQUIVALENT, BUYER, OTHER].map((buyer) => sameCanonicalClaimIdentity(retained.buyer, buyer)), [true, true, false]);
  }

  // A first attempt that names another job, buyer or scope fails once. Only the row's own party gets that cause
  // back; the stranger repeating its identical attempt finds the nonce consumed.
  const changes = [{ jobId: job('other') }, { buyer: OTHER }, { challengeScopeHash: hash('other scope') }];
  for (const operator of [false, true]) for (const change of changes) {
    const w = world(t);
    const { sessionNonce } = operator ? w.ledger.issueForOperator({ jobId: job('one'), buyer: BUYER }) : w.issue();
    const route = operator ? { path: 'proposal', challengeScopeHash: null } : {};
    w.statements.length = 0;
    assert.deepEqual(w.attempt(sessionNonce, { ...route, ...change }), refused('context_challenge_mismatch'));
    assert.equal(w.mutations().length, 1);
    assert.deepEqual(w.quiet(() => w.attempt(sessionNonce, { ...route, ...change })), refused('context_challenge_consumed'), `stranger ${Object.keys(change)}`);
    assert.deepEqual(w.quiet(() => w.attempt(sessionNonce, route)), refused('context_challenge_failed', 409, 'context_challenge_mismatch'));
  }
});

// Field × bad value cells. Entries accept only the fields listed for them; every other pair is N/A.
const bad = (valid, upper) => [['missing', undefined], ['null', null], ['number', 42], ['wrong length', valid.slice(0, -1)], ['uppercase', upper], ['object', {}]];
const BAD_JOB = bad(job('one'), job('one').toLowerCase());
const BAD_BUYER = bad(BUYER, `did:demos:agent:${hash('claim buyer').toUpperCase()}`);
const BAD_HASH = bad(SCOPE, SCOPE.toUpperCase());

cardTest('T15', (t) => {
  const w = world(t);
  const untouched = (label) => {
    assert.deepEqual(w.statements, [], label);
    assert.equal(w.control.ports, 0, label);
    assert.equal(w.rows().length, 0, label);
    w.statements.length = 0;
  };
  for (const [name, value] of BAD_JOB) for (const entry of ['issue', 'issueForOperator']) {
    refusal(() => w.ledger[entry]({ jobId: value, buyer: BUYER }, SCOPE, LIVE), 'peer_job_invalid');
    untouched(`${entry} job ${name}`);
  }
  for (const [name, value] of BAD_BUYER) for (const entry of ['issue', 'issueForOperator']) {
    refusal(() => w.ledger[entry]({ jobId: job('one'), buyer: value }, SCOPE, LIVE), 'context_scope_invalid');
    untouched(`${entry} buyer ${name}`);
  }
  for (const [name, value] of BAD_HASH) {
    refusal(() => w.ledger.issue({ jobId: job('one'), buyer: BUYER }, value, LIVE), 'context_scope_invalid');
    untouched(`issue scope ${name}`);
  }
  for (const entry of ['issue', 'issueForOperator']) for (const request of [{}, undefined, null]) {
    refusal(() => w.ledger[entry](request, SCOPE, LIVE), 'peer_job_invalid');
    untouched(`${entry} empty request`);
  }
  for (const authorization of [undefined, null, {}, { assertStillLive: 1 }]) {
    assert.throws(() => w.ledger.issue({ jobId: job('one'), buyer: BUYER }, SCOPE, authorization), TypeError);
    untouched('issue without a final-liveness closure');
  }

  // attempt: a malformed, uppercase or unknown nonce is a mismatch with no write.
  const unknown = hash('unknown nonce');
  for (const [name, value] of [...BAD_HASH, ['unknown', unknown]]) {
    w.statements.length = 0;
    assert.deepEqual(w.attempt(value), refused('context_challenge_mismatch'), `nonce ${name}`);
    assert.deepEqual(w.mutations(), []);
  }
  // attempt: a live issued nonce with a bad job, buyer or scope fails once as a mismatch.
  const fields = [['jobId', BAD_JOB], ['buyer', BAD_BUYER], ['challengeScopeHash', BAD_HASH]];
  for (const [field, variants] of fields) for (const [name, value] of variants) {
    const fresh = world(t);
    const { sessionNonce } = fresh.issue();
    fresh.statements.length = 0;
    assert.deepEqual(fresh.attempt(sessionNonce, { [field]: value }), refused('context_challenge_mismatch'), `${field} ${name}`);
    assert.equal(fresh.mutations().length, 1);
    const row = fresh.ledger.retained(sessionNonce);
    assert.deepEqual([row.state, row.failure.code], ['failed', 'context_challenge_mismatch']);
  }
  // attempt: a null or malformed presentation hash fails once as attempt_invalid; a different valid one is consumed.
  for (const [name, value] of [...BAD_HASH, ['"bad"', 'bad']]) {
    const fresh = world(t);
    const { sessionNonce } = fresh.issue();
    fresh.statements.length = 0;
    assert.deepEqual(fresh.attempt(sessionNonce, { presentationHash: value }), refused('context_challenge_attempt_invalid'), `presentation ${name}`);
    assert.equal(fresh.mutations().length, 1);
    assert.equal(fresh.ledger.retained(sessionNonce).failure.code, 'context_challenge_attempt_invalid');
    assert.deepEqual(fresh.quiet(() => fresh.attempt(sessionNonce)), refused('context_challenge_consumed'));
  }

  // accept: each record field × bad value refuses before any mutation and leaves the row attempted.
  const { nonce, owner } = w.attempted();
  const record = w.record(nonce);
  const recordCells = [
    ['buyerBundleText', [['missing', undefined], ['null', null], ['number', 42], ['not JSON', 'not json'], ['not an object', '[]'], ['object', {}]]],
    ['buyerBundleHash', BAD_HASH],
    ['admission', [['missing', undefined], ['null', null], ['number', 42], ['empty object', {}], ['other job', { ...record.admission, jobId: job('other') }], ['other buyer', { ...record.admission, buyer: OTHER }]]],
    ['admittedAt', [['missing', undefined], ['null', null], ['string', '1'], ['negative', -1], ['fraction', 1.5], ['unsafe', MAX_SAFE + 1]]],
    ['firstAdmission', [['missing', undefined], ['null', null], ['number', 42], ['empty object', {}], ['partial', { generatedAt: T0 }], ['extra key', { ...record.firstAdmission, extra: 1 }]]],
  ];
  for (const [field, variants] of recordCells) for (const [name, value] of variants) {
    const malformed = { ...record, [field]: value };
    if (value === undefined) delete malformed[field];
    const before = w.rows();
    w.statements.length = 0;
    refusal(() => w.ledger.accept(owner, nonce, malformed), 'context_challenge_attempt_invalid');
    assert.deepEqual([w.mutations(), w.rows()], [[], before], `accepted ${field} ${name}`);
  }
  refusal(() => w.ledger.accept(owner, nonce, { ...record, extra: true }), 'context_challenge_attempt_invalid');
  // accept and recordFailed: an invalid nonce or owner matches nothing and writes nothing (T22 covers real non-owners).
  const forgeries = [...BAD_HASH.map(([name, value]) => [`nonce ${name}`, value, owner]),
    ...[['missing', undefined], ['null', null], ['empty', {}], ['no attempt', { generation: owner.generation }], ['numbers', { generation: 1, attemptId: 2 }]].map(([name, value]) => [`owner ${name}`, nonce, value])];
  for (const [name, forgedNonce, forgedOwner] of forgeries) {
    w.statements.length = 0;
    assert.equal(w.ledger.accept(forgedOwner, forgedNonce, record), false, name);
    assert.equal(w.ledger.recordFailed(forgedOwner, forgedNonce, 'seller_budget_refused'), false, name);
    assert.deepEqual(w.mutations(), [], name);
  }
  // recordFailed: a missing, empty or non-string code, or a status outside 400-599, refuses before mutation.
  for (const [name, code, status] of [['missing code', undefined], ['null code', null], ['number code', 42], ['empty code', ''], ['object code', {}], ['low status', 'x_code', 99], ['high status', 'x_code', 600], ['fraction status', 'x_code', 409.5], ['null status', 'x_code', null]]) {
    w.statements.length = 0;
    refusal(() => w.ledger.recordFailed(owner, nonce, code, status), 'context_challenge_attempt_invalid');
    assert.deepEqual(w.mutations(), [], name);
  }
  assert.equal(w.ledger.retained(nonce).state, 'attempted');
});

cardTest('T16', (t) => {
  const w = world(t);
  const { sessionNonce, expiresAt } = w.issue();
  w.control.now = expiresAt - 1;
  assert.equal(w.attempt(sessionNonce).kind, 'validate');
  const late = w.issue('two');
  w.control.now = late.expiresAt;
  assert.deepEqual(w.attempt(late.sessionNonce, { jobId: job('two') }), refused('context_challenge_expired'));
  assert.deepEqual(w.ledger.retained(late.sessionNonce).failure, { code: 'context_challenge_expired', status: 409, at: late.expiresAt });
});

cardTest('T18', (t) => {
  const w = world(t);
  const { nonce } = w.attempted();
  assert.deepEqual(w.quiet(() => w.attempt(nonce)), refused('context_attempt_pending', 503));
  assert.deepEqual(w.quiet(() => w.attempt(nonce, { presentationHash: hash('another') })), refused('context_challenge_consumed'));
  assert.equal(w.ledger.retained(nonce).state, 'attempted');
});

cardTest('T19', (t) => {
  const w = world(t);
  const { nonce, owner } = w.attempted();
  assert.equal(w.ledger.recordFailed(owner, nonce, 'session_not_admitted'), true);
  assert.deepEqual(w.quiet(() => w.attempt(nonce)), refused('context_challenge_failed', 409, 'session_not_admitted'));
  assert.deepEqual(w.quiet(() => w.attempt(nonce, { presentationHash: hash('another') })), refused('context_challenge_consumed'));
  quietRefusal(w, () => w.issue(), 'context_job_closed', 409);
  const row = w.ledger.retained(nonce);
  assert.deepEqual(row.failure, { code: 'session_not_admitted', status: 409, at: T0 });

  const unavailable = world(t);
  const second = unavailable.attempted();
  assert.equal(unavailable.ledger.recordFailed(second.owner, second.nonce, 'session_admission_unavailable', 503), true);
  assert.equal(unavailable.ledger.retained(second.nonce).failure.status, 503, 'the recorded status is kept');
  assert.deepEqual(unavailable.attempt(second.nonce), refused('context_challenge_failed', 409, 'session_admission_unavailable'));
});

cardTest('T20', (t) => {
  const w = world(t, { limits: { maxPerHour: 100, maxPerBuyerPerHour: 100 } });
  const lost = [w.attempted('lost one'), w.attempted('lost two')];
  const accepted = w.accepted('accepted').nonce;
  const failedRow = w.attempted('failed');
  w.ledger.recordFailed(failedRow.owner, failedRow.nonce, 'session_not_admitted');
  const issued = w.issue('issued').sessionNonce;
  const settled = () => [accepted, failedRow.nonce, issued].map((nonce) => w.rows().find((row) => row.nonce === nonce));
  const before = settled();

  w.reopen('generation-two');
  assert.equal(w.ledger.closeLostValidations(), 2);
  for (const [label, { nonce }] of [['lost one', lost[0]], ['lost two', lost[1]]]) {
    const row = w.ledger.retained(nonce);
    assert.deepEqual([row.state, row.failure.code, row.failure.status], ['failed', 'validator_lost', 409]);
    assert.deepEqual(w.quiet(() => w.attempt(nonce, { jobId: job(label) })), refused('context_challenge_failed', 409, 'validator_lost'), label);
    assert.deepEqual(w.quiet(() => w.attempt(nonce, { jobId: job('another job') })), refused('context_challenge_consumed'), `${label} for another job`);
  }
  assert.deepEqual(settled(), before);
  // A validation this generation owns is not closed, and closing again finds nothing.
  const current = w.attempted('current');
  const rows = w.rows();
  assert.equal(w.ledger.closeLostValidations(), 0);
  assert.deepEqual(w.rows(), rows);
  assert.equal(w.ledger.retained(current.nonce).state, 'attempted');
});

cardTest('T22', (t) => {
  const w = world(t);
  const { nonce, owner } = w.attempted();
  const record = w.record(nonce);
  const strangers = [{ ...owner, attemptId: hash('other attempt') }, { ...owner, generation: 'generation-two' }];
  for (const stranger of strangers) {
    const before = w.rows();
    assert.deepEqual(w.quiet(() => [w.ledger.accept(stranger, nonce, record), w.ledger.recordFailed(stranger, nonce, 'session_not_admitted')]), [false, false]);
    assert.deepEqual(w.rows(), before);
  }
  // Rows that are not attempted never change, even for their former owner.
  const done = world(t);
  const doneRow = done.accepted();
  const failed = world(t);
  const failedRow = failed.attempted();
  failed.ledger.recordFailed(failedRow.owner, failedRow.nonce, 'session_not_admitted');
  const fresh = world(t);
  const { sessionNonce } = fresh.issue();
  for (const [x, rowNonce, rowOwner] of [[done, doneRow.nonce, doneRow.owner], [failed, failedRow.nonce, failedRow.owner], [fresh, sessionNonce, owner]]) {
    const before = x.rows();
    assert.deepEqual(x.quiet(() => [x.ledger.accept(rowOwner, rowNonce, x.record(rowNonce)), x.ledger.recordFailed(rowOwner, rowNonce, 'seller_budget_refused')]), [false, false]);
    assert.deepEqual(x.rows(), before);
  }
  assert.equal(fresh.ledger.retained(sessionNonce).state, 'issued');
  // The owner still works once, and only once.
  assert.equal(w.ledger.accept(owner, nonce, record), true);
  assert.equal(w.ledger.accept(owner, nonce, record), false);
});

// Starts a ledger process and waits until it is ready; `release` lets it run, `finish` waits for it to end.
async function startWorker(path, action, input) {
  const child = fork(fileURLToPath(new URL('./helpers/challenge-ledger-worker.mjs', import.meta.url)), [path, action, JSON.stringify({ now: T0, generation: hash(`process ${input.request.jobId}`), ...input })]);
  await once(child, 'message');
  const received = [];
  child.on('message', (message) => received.push(message));
  const exited = once(child, 'exit');
  return { release: () => child.send('go'), finish: async () => { const [code, signal] = await exited; return { code, signal, answer: received[0] }; } };
}

cardTest('T23', async (t) => {
  const w = world(t);
  let index = 0;
  for (const [buyer, count] of [[BUYER, 5], [OTHER, 5], [SELLER, 1]]) for (let i = 0; i < count; i++) w.issue(index++, buyer);
  assert.equal(w.rows().length, 11);
  w.db.close();
  const workers = await Promise.all([claim('first racer'), claim('second racer')].map((buyer) => startWorker(w.path, 'issue', { request: { jobId: job(buyer), buyer }, scope: SCOPE })));
  for (const worker of workers) worker.release();
  const answers = (await Promise.all(workers.map((worker) => worker.finish()))).map(({ answer }) => answer);
  assert.equal(answers.filter((answer) => answer.sessionNonce).length, 1);
  assert.deepEqual(answers.find((answer) => answer.code), { code: 'context_challenge_limit', status: 429 });
  w.reopen();
  assert.equal(w.rows().length, 12);
});

cardTest('T24', (t) => {
  const w = world(t);
  const second = w.connect('generation-one');
  const { sessionNonce } = w.issue();
  const results = [w.ledger, second.ledger].map((ledger) => ledger.attempt(w.input(sessionNonce)));
  assert.deepEqual(results.map(({ kind }) => kind).sort(), ['refused', 'validate']);
  assert.deepEqual(results.find(({ kind }) => kind === 'refused'), refused('context_attempt_pending', 503));
  const owners = w.rows().filter((row) => row.state === 'attempted').map((row) => row.owner);
  assert.deepEqual(owners.map((text) => JSON.parse(text)), [results.find(({ kind }) => kind === 'validate').owner]);
});

cardTest('T25', (t) => {
  const w = world(t);
  const { sessionNonce } = w.issue();
  w.control.ready = false;
  assert.deepEqual(w.quiet(() => w.attempt(sessionNonce)), refused('seller_not_ready', 503));
  assert.equal(w.ledger.retained(sessionNonce).state, 'issued');
  w.control.ready = true;
  assert.equal(w.attempt(sessionNonce).kind, 'validate');
});

cardTest('T26', (t) => {
  const damage = {
    'no accepted record': () => null,
    'unreadable record': () => '{',
    'no bundle text': (record) => JSON.stringify({ ...record, buyerBundleText: undefined }),
    'no admission': (record) => JSON.stringify({ ...record, admission: undefined }),
    'admission of another job': (record) => JSON.stringify({ ...record, admission: { ...record.admission, jobId: job('other') } }),
  };
  for (const [name, change] of Object.entries(damage)) {
    const w = world(t);
    const { nonce, record } = w.accepted();
    w.db.prepare('UPDATE kit_challenges SET accepted = ? WHERE nonce = ?').run(change(record), nonce);
    assert.deepEqual(w.quiet(() => w.attempt(nonce)), refused('session_admission_unavailable', 503), name);
    assert.equal(w.ledger.retained(nonce).state, 'accepted', `${name} stays accepted`);
  }
});

cardTest('T27', (t) => {
  const operator = world(t);
  const { sessionNonce } = operator.ledger.issueForOperator({ jobId: job('one'), buyer: BUYER });
  assert.equal(operator.ledger.retained(sessionNonce).origin, 'operator');
  assert.equal(operator.ledger.retained(sessionNonce).challengeScopeHash, null);
  operator.statements.length = 0;
  assert.deepEqual(operator.attempt(sessionNonce, { path: 'context', challengeScopeHash: null }), refused('context_challenge_mismatch'));
  assert.equal(operator.mutations().length, 1);
  assert.equal(operator.ledger.retained(sessionNonce).failure.code, 'context_challenge_mismatch');
  // A replay on `context`, by its buyer or any other, is not the row's party and finds the nonce consumed.
  for (const buyer of [BUYER, OTHER]) {
    assert.deepEqual(operator.quiet(() => operator.attempt(sessionNonce, { path: 'context', challengeScopeHash: null, buyer })), refused('context_challenge_consumed'), buyer);
  }

  const proposal = world(t);
  const second = proposal.ledger.issueForOperator({ jobId: job('one'), buyer: BUYER });
  assert.equal(proposal.attempt(second.sessionNonce, { path: 'proposal', challengeScopeHash: null }).kind, 'validate');

  const route = world(t);
  const routed = route.issue();
  assert.deepEqual(route.quiet(() => route.attempt(routed.sessionNonce, { path: 'proposal' })), refused('context_challenge_mismatch'));
  assert.equal(route.ledger.retained(routed.sessionNonce).state, 'issued', 'the route nonce is not consumed');
  assert.equal(route.attempt(routed.sessionNonce).kind, 'validate');
});

cardTest('T28', (t) => {
  const w = world(t);
  w.statements.length = 0;
  w.issue();
  assert.deepEqual(w.mutations().map((sql) => sql.trim().split(/\s+/)[0].toUpperCase()), ['INSERT']);
  assert.deepEqual(readdirSync(w.directory), ['store.sqlite']);
});

test('the ledger is not exported from the package index', async () => {
  const index = await import('../src/index.mjs');
  assert.equal(Object.keys(index).some((name) => /ChallengeLedger/i.test(name)), false);
});

test('construction refuses async callbacks, a missing generation and unusable limits', (t) => {
  const w = world(t);
  const options = { db: w.db, transaction: (run) => run(), now: () => T0, generation: 'g', sessionState: () => null, admissionCounts: () => ({}), ready: () => true, stopped: () => false };
  assert.ok(createSellerChallengeLedger(options));
  for (const change of [{ now: async () => T0 }, { sessionState: async () => null }, { admissionCounts: async () => ({}) }, { ready: async () => true }, { stopped: async () => false }, { transaction: async (run) => run() },
    { transaction: undefined }, { generation: '' }, { generation: 7 }, { limits: { maxPerJob: 0 } }, { limits: { maxPerJob: 1.5 } }, { limits: { maxPerJobs: 3 } }]) {
    assert.throws(() => createSellerChallengeLedger({ ...options, ...change }), TypeError, JSON.stringify(Object.keys(change)));
  }
});

test('challenge-issuance-commit-answer-cuts', async (t) => {
  // Cut before the commit: the reclamation and the insertion roll back together.
  const rolledBack = world(t, { limits: { maxChallenges: 1 } });
  const stale = rolledBack.issue('stale').sessionNonce;
  rolledBack.control.now = T0 + 2 * HOUR;
  rolledBack.control.sessionState = (jobId) => (jobId === job('stale') ? 'finalised' : null);
  rolledBack.control.fault = 'before-commit';
  assert.throws(() => rolledBack.issue('fresh'), /cut before commit/);
  assert.deepEqual(rolledBack.rows().map((row) => row.nonce), [stale], 'the old row survives and no new row exists');
  rolledBack.control.fault = null;
  assert.notEqual(rolledBack.issue('fresh').sessionNonce, stale);
  assert.equal(rolledBack.rows().length, 1);

  // Cut after the commit, before the answer: the retry returns the same live nonce and charges nothing more.
  const committed = world(t);
  committed.control.fault = 'after-commit';
  assert.throws(() => committed.issue(), /cut after commit/);
  committed.control.fault = null;
  const [row] = committed.rows();
  assert.deepEqual(committed.quiet(() => committed.issue()), { sessionNonce: row.nonce, expiresAt: row.expiresAt });
  assert.equal(committed.rows().length, 1);

  // The same cut with a real process killed after the commit.
  const killed = world(t);
  killed.db.close();
  const buyer = claim('killed');
  const worker = await startWorker(killed.path, 'issue-then-die', { request: { jobId: job('one'), buyer }, scope: SCOPE });
  worker.release();
  assert.deepEqual(await worker.finish(), { code: null, signal: 'SIGKILL', answer: undefined });
  killed.reopen('generation-two');
  const [survivor] = killed.rows();
  assert.deepEqual(killed.quiet(() => killed.issue('one', buyer)), { sessionNonce: survivor.nonce, expiresAt: survivor.expiresAt });
  assert.equal(killed.rows().length, 1);
});

test('challenge-final-liveness-barrier', (t) => {
  const calls = [];
  const closure = (error) => ({ assertStillLive() { calls.push('liveness'); if (error) throw error; } });
  const expired = Object.assign(new Error('peer_expired'), { code: 'peer_expired', status: 408 });
  const w = world(t);
  const request = { jobId: job('one'), buyer: BUYER };
  // The closure runs once, inside the transaction, after every count and the stop check, and its refusal writes nothing.
  Object.defineProperty(w.control.counts, 'starts', { get() { calls.push('counts'); return 0; } });
  w.control.stopped = true;
  quietRefusal(w, () => w.ledger.issue(request, SCOPE, closure(expired)), 'seller_stopped', 503);
  assert.deepEqual(calls, ['counts'], 'a stop answers before the liveness closure');
  w.control.stopped = false;
  calls.length = 0;
  w.quiet(() => assert.throws(() => w.ledger.issue(request, SCOPE, closure(expired)), expired));
  assert.deepEqual(calls, ['counts', 'liveness']);
  assert.equal(w.rows().length, 0);
  // It sees an open transaction, and an asynchronous closure is refused rather than awaited.
  let open;
  w.ledger.issue(request, SCOPE, { assertStillLive() { open = w.db.inTransaction; } });
  assert.equal(open, true);
  const other = world(t);
  other.quiet(() => assert.throws(() => other.ledger.issue(request, SCOPE, { assertStillLive: async () => {} }), TypeError));
  // An earlier refusal never reaches it, and the operator entry has no closure to call.
  calls.length = 0;
  w.control.counts.contextRecords = CHALLENGE_LIMIT_DEFAULTS.maxContextRecords;
  quietRefusal(w, () => w.ledger.issue({ jobId: job('two'), buyer: BUYER }, SCOPE, closure()), 'peer_context_capacity', 503);
  assert.equal(calls.includes('liveness'), false);
});

test('challenge-reused-nonce-passes-the-final-barrier', (t) => {
  const calls = [];
  const closure = (error) => ({ assertStillLive() { calls.push('liveness'); if (error) throw error; } });
  const expired = Object.assign(new Error('peer_expired'), { code: 'peer_expired', status: 408 });
  const request = { jobId: job('one'), buyer: BUYER };
  const entries = {
    route: (w, authorization = LIVE) => w.ledger.issue(request, SCOPE, authorization),
    operator: (w) => w.ledger.issueForOperator(request),
  };
  for (const [origin, issue] of Object.entries(entries)) for (const reopened of [false, true]) {
    const label = `${origin} ${reopened ? 'reopened' : 'live'}`;
    const w = world(t);
    const first = issue(w);
    if (reopened) w.reopen();
    // Every count at its limit and no stop: the reused nonce still comes back with no count read, no write and no second charge.
    Object.assign(w.control.counts, { contextRecords: CHALLENGE_LIMIT_DEFAULTS.maxContextRecords, starts: CHALLENGE_LIMIT_DEFAULTS.maxStartsPerHour });
    w.control.countReads = 0;
    assert.deepEqual(w.quiet(() => issue(w)), first, label);
    assert.equal(w.control.countReads, 0, `${label}: a reused nonce reads no counts`);
    w.control.counts.contextRecords = 0;
    w.control.counts.starts = 0;
    // A stop, or a stop value that is not exactly false, refuses the reused nonce too.
    for (const stopped of [true, 'yes', undefined]) {
      w.control.stopped = stopped;
      quietRefusal(w, () => issue(w), 'seller_stopped', 503);
    }
    w.control.stopped = false;
    // So does the guard switched off once the transaction is open, and, on the route, its final liveness refusal.
    w.control.sessionState = () => { guard.setKitOperationGuardForTest('off'); return null; };
    try {
      w.quiet(() => assert.throws(() => issue(w), { code: 'kit_operation_guard_off', name: 'KitOperationGuardError' }), label);
    } finally { guard.setKitOperationGuardForTest('testnet-tp1'); }
    w.control.sessionState = () => null;
    if (origin === 'route') w.quiet(() => assert.throws(() => issue(w, closure(expired)), expired));
    assert.deepEqual(w.quiet(() => issue(w)), first, `${label}: answered again once the stop is lifted`);
    assert.equal(w.rows().length, 1);
  }

  // The route's closure runs once, last, on a reused nonce; its refusal is not swallowed and a stop answers before it.
  const w = world(t);
  const first = entries.route(w);
  calls.length = 0;
  Object.defineProperty(w.control.counts, 'starts', { get() { calls.push('counts'); return 0; } });
  w.quiet(() => assert.throws(() => entries.route(w, closure(expired)), expired));
  assert.deepEqual(calls, ['liveness'], 'a reused nonce reads no counts');
  calls.length = 0;
  w.control.stopped = true;
  quietRefusal(w, () => entries.route(w, closure(expired)), 'seller_stopped', 503);
  assert.deepEqual(calls, [], 'a stop answers before the liveness closure');
  w.control.stopped = false;
  w.quiet(() => assert.throws(() => entries.route(w, { assertStillLive: async () => {} }), TypeError));
  assert.deepEqual(w.quiet(() => entries.route(w, closure())), first);
});

// Builds a row of `origin` for job `label` in one past-`issued` state; returns its nonce and the answer its party gets back.
function rowInState(w, origin, state, label) {
  const party = { jobId: job(label), buyer: BUYER, ...(origin === 'route' ? { path: 'context', challengeScopeHash: SCOPE } : { path: 'proposal', challengeScopeHash: null }) };
  const { sessionNonce: nonce, expiresAt } = origin === 'route' ? w.issue(label) : w.ledger.issueForOperator({ jobId: job(label), buyer: BUYER });
  const attempt = (overrides = {}) => w.ledger.attempt({ nonce, ...party, presentationHash: presentationOf(nonce), ...overrides });
  const failed = (cause) => refused('context_challenge_failed', 409, cause);
  if (state === 'failed as mismatch') attempt({ buyer: OTHER });
  if (state === 'failed as attempt_invalid') attempt({ presentationHash: null });
  if (state === 'failed as expired') { w.control.now = expiresAt; attempt(); w.control.now = T0; }
  if (['failed as mismatch', 'failed as attempt_invalid', 'failed as expired'].includes(state)) return { nonce, party, answer: failed(`context_challenge_${state.slice(10)}`) };
  const { owner } = attempt();
  if (state === 'attempted' || state === 'failed as validator_lost') return { nonce, party, answer: state === 'attempted' ? refused('context_attempt_pending', 503) : failed('validator_lost') };
  if (state === 'failed by the validator') return w.ledger.recordFailed(owner, nonce, 'session_not_admitted') && { nonce, party, answer: failed('session_not_admitted') };
  const record = w.record(nonce, label);
  return w.ledger.accept(owner, nonce, record) && { nonce, party, answer: { kind: 'continuation', accepted: record } };
}

test('challenge-replay-answers-only-the-row-party', (t) => {
  const states = ['failed as validator_lost', 'accepted', 'attempted', 'failed by the validator', 'failed as mismatch', 'failed as expired', 'failed as attempt_invalid'];
  for (const origin of ['route', 'operator']) for (const reopened of [false, true]) {
    const w = world(t, { limits: { maxPerHour: 100, maxPerBuyerPerHour: 100 } });
    // The lost validation is left by an earlier generation; the startup pass of this one closes it.
    const rows = [rowInState(w, origin, states[0], states[0])];
    w.reopen('generation-two');
    assert.equal(w.ledger.closeLostValidations(), 1);
    rows.push(...states.slice(1).map((state) => rowInState(w, origin, state, state)));
    if (reopened) w.reopen('generation-two');
    rows.forEach(({ nonce, party, answer }, index) => {
      const stored = w.ledger.retained(nonce).presentationHash ?? undefined;
      const presenters = {
        'its party': [{}, true],
        'an equivalent buyer': [{ buyer: EQUIVALENT }, true],
        'its party with the scope absent': [{ challengeScopeHash: undefined }, origin === 'operator'],
        'another buyer': [{ buyer: OTHER }, false],
        'another job': [{ jobId: job('another job') }, false],
        'another scope': [{ challengeScopeHash: hash('another scope') }, false],
        // Only a route row's context step is continued on the proposal path, and only while it validates or once accepted.
        'the other path': [{ path: origin === 'route' ? 'proposal' : 'context' }, origin === 'route' && ['attempted', 'accepted'].includes(states[index])],
        'another presentation': [{ presentationHash: hash('another presentation') }, false],
        'no presentation': [{ presentationHash: undefined }, stored === undefined],
      };
      for (const [name, [change, answered]] of Object.entries(presenters)) {
        const label = `${origin} ${reopened ? 'reopened' : 'live'} ${states[index]}: ${name}`;
        const before = w.rows();
        const result = w.quiet(() => w.ledger.attempt({ nonce, ...party, presentationHash: stored, ...change }));
        assert.deepEqual(result, answered ? answer : refused('context_challenge_consumed'), label);
        assert.deepEqual(w.rows(), before, `${label} changes nothing`);
      }
    });
  }
});

test('challenge-route-row-is-continued-on-proposal-only-for-its-party', (t) => {
  for (const reopened of [false, true]) {
    const w = world(t, { limits: { maxPerHour: 100, maxPerBuyerPerHour: 100 } });
    const rows = ['attempted', 'accepted', 'failed by the validator'].map((state) => rowInState(w, 'route', state, state));
    if (reopened) w.reopen('generation-two');
    rows.forEach(({ nonce, party, answer }, index) => {
      const continued = index < 2;
      const onProposal = (change = {}) => w.quiet(() => w.ledger.attempt({ nonce, ...party, presentationHash: presentationOf(nonce), ...change, path: 'proposal' }));
      for (const [name, change, answered] of [['its party', {}, true], ['an equivalent buyer', { buyer: EQUIVALENT }, true], ['another buyer', { buyer: OTHER }, false],
        ['another job', { jobId: job('another job') }, false], ['another scope', { challengeScopeHash: hash('another scope') }, false],
        ['another presentation', { presentationHash: hash('another presentation') }, false]]) {
        const label = `${reopened ? 'reopened' : 'live'} ${['attempted', 'accepted', 'failed'][index]}: ${name}`;
        const before = w.rows();
        assert.deepEqual(onProposal(change), answered && continued ? answer : refused('context_challenge_consumed'), label);
        assert.deepEqual(w.rows(), before, `${label} changes nothing`);
      }
    });
  }
});

test('challenge-operator-scope-absent-is-null', (t) => {
  const withoutScope = (input) => Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'challengeScopeHash'));
  for (const absent of [(input) => ({ ...input, challengeScopeHash: undefined }), withoutScope]) {
    const w = world(t);
    const { sessionNonce } = w.ledger.issueForOperator({ jobId: job('one'), buyer: BUYER });
    const proposal = absent(w.input(sessionNonce, { path: 'proposal' }));
    const { kind, owner } = w.ledger.attempt(proposal);
    assert.equal(kind, 'validate', 'the first attempt with no scope is the party');
    const record = w.record(sessionNonce);
    assert.equal(w.ledger.accept(owner, sessionNonce, record), true);
    for (const input of [proposal, { ...proposal, challengeScopeHash: null }]) assert.deepEqual(w.quiet(() => w.ledger.attempt(input)), { kind: 'continuation', accepted: record });
  }
});

test('challenge-first-attempt-must-change-its-row', (t) => {
  for (const change of [{}, { buyer: OTHER }]) {
    const w = world(t);
    const { sessionNonce } = w.issue();
    // A store whose row does not move under the lock: the transition changes 0 rows, so the attempt throws and rolls back.
    w.db.exec("CREATE TRIGGER hold_issued BEFORE UPDATE ON kit_challenges WHEN OLD.state = 'issued' BEGIN SELECT RAISE(IGNORE); END");
    assert.throws(() => w.attempt(sessionNonce, change), /changed under the ledger lock/, JSON.stringify(change));
    assert.equal(w.db.inTransaction, false);
    assert.equal(w.ledger.retained(sessionNonce).state, 'issued', 'no owner is answered for a row it does not hold');
    w.db.exec('DROP TRIGGER hold_issued');
    assert.equal(w.attempt(sessionNonce).kind, 'validate');
  }
});

test('challenge-drain-state-table', (t) => {
  const w = world(t);
  const acceptedRow = w.accepted();
  const pending = world(t);
  const pendingRow = pending.attempted();
  const failedWorld = world(t);
  const failedRow = failedWorld.attempted();
  failedWorld.ledger.recordFailed(failedRow.owner, failedRow.nonce, 'session_not_admitted');
  const issuedWorld = world(t);
  const { sessionNonce } = issuedWorld.issue();
  const other = hash('another presentation');
  const cells = [
    [w, acceptedRow.nonce, {}, { kind: 'continuation', accepted: acceptedRow.record }],
    [w, acceptedRow.nonce, { presentationHash: other }, refused('context_challenge_consumed')],
    [pending, pendingRow.nonce, {}, refused('context_attempt_pending', 503)],
    [pending, pendingRow.nonce, { presentationHash: other }, refused('context_challenge_consumed')],
    [failedWorld, failedRow.nonce, {}, refused('context_challenge_failed', 409, 'session_not_admitted')],
    [failedWorld, failedRow.nonce, { presentationHash: other }, refused('context_challenge_consumed')],
    [issuedWorld, hash('unknown'), {}, refused('context_challenge_mismatch')],
    [issuedWorld, 'XYZ', {}, refused('context_challenge_mismatch')],
    [issuedWorld, sessionNonce, {}, refused('seller_not_ready', 503)],
  ];
  for (const x of [w, pending, failedWorld, issuedWorld]) x.control.ready = false;
  for (const [x, nonce, overrides, expected] of cells) assert.deepEqual(x.quiet(() => x.attempt(nonce, overrides)), expected, `${nonce.slice(0, 3)} ${JSON.stringify(Object.keys(overrides))}`);
  assert.equal(issuedWorld.ledger.retained(sessionNonce).state, 'issued', 'not consumed while not ready');
});

test('challenge-late-validator-after-reopen', (t) => {
  const w = world(t);
  const { nonce, owner } = w.attempted();
  const record = w.record(nonce);
  w.reopen('generation-two');
  // Before the startup pass has closed the old row, the old owner still cannot win.
  assert.deepEqual(w.quiet(() => [w.ledger.accept(owner, nonce, record), w.ledger.recordFailed(owner, nonce, 'session_not_admitted')]), [false, false]);
  assert.equal(w.ledger.retained(nonce).state, 'attempted');
  assert.equal(w.ledger.closeLostValidations(), 1);
  assert.deepEqual(w.quiet(() => [w.ledger.accept(owner, nonce, record), w.ledger.recordFailed(owner, nonce, 'session_not_admitted')]), [false, false]);
  const row = w.ledger.retained(nonce);
  assert.deepEqual([row.state, row.failure.code], ['failed', 'validator_lost']);
});

test('challenge-failed-answer-lost-restart', (t) => {
  const w = world(t);
  const { nonce, owner } = w.attempted();
  w.control.fault = 'after-commit';
  assert.throws(() => w.ledger.recordFailed(owner, nonce, 'session_not_admitted', 503), /cut after commit/);
  w.control.fault = null;
  w.reopen('generation-two');
  assert.equal(w.ledger.closeLostValidations(), 0, 'the committed refusal is not an attempt to close');
  assert.deepEqual(w.quiet(() => w.attempt(nonce)), refused('context_challenge_failed', 409, 'session_not_admitted'));
  assert.deepEqual(w.quiet(() => w.attempt(nonce, { presentationHash: hash('another') })), refused('context_challenge_consumed'));
  assert.equal(w.ledger.retained(nonce).failure.status, 503);
  quietRefusal(w, () => w.issue(), 'context_job_closed', 409);
});

test('challenge-accept-commit-cuts-retain-exact-bytes', (t) => {
  const w = world(t);
  const { nonce, owner } = w.attempted();
  const record = w.record(nonce);
  w.control.fault = 'before-commit';
  assert.throws(() => w.ledger.accept(owner, nonce, record), /cut before commit/);
  assert.equal(w.ledger.retained(nonce).state, 'attempted', 'a cut before the commit accepts nothing');
  w.control.fault = 'after-commit';
  assert.throws(() => w.ledger.accept(owner, nonce, record), /cut after commit/);
  w.control.fault = null;
  w.reopen('generation-two');
  const retained = w.ledger.retained(nonce);
  assert.equal(retained.state, 'accepted');
  assert.equal(retained.accepted.buyerBundleText, record.buyerBundleText, 'the complete bundle text is kept byte for byte');
  assert.deepEqual(w.quiet(() => w.attempt(nonce)), { kind: 'continuation', accepted: record });
  assert.deepEqual(w.quiet(() => w.attempt(nonce, { presentationHash: hash('another bundle') })), refused('context_challenge_consumed'));
});

// A second ledger on the same store whose transaction waits `waitMs` for the lock, as a busy store does, before it runs the callback.
function waitingLedger(w, waitMs, generation = 'generation-one') {
  const { db, control } = w;
  return createSellerChallengeLedger({
    db, generation, now: () => control.now,
    transaction(run) {
      control.now += waitMs;
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = run();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    sessionState: () => null, admissionCounts: () => ({ contextRecords: 0, starts: 0, buyerStarts: () => 0 }), ready: () => true, stopped: () => false,
  });
}

test('challenge-issue-reads-the-clock-once-the-lock-is-held', (t) => {
  const w = world(t);
  const first = w.issue();
  const waiting = waitingLedger(w, 20);
  // A nonce still live once the lock is held is reused with no write.
  w.control.now = first.expiresAt - 30;
  assert.deepEqual(w.quiet(() => waiting.issue({ jobId: job('one'), buyer: BUYER }, SCOPE, LIVE)), first);
  // A nonce that expires while the transaction waits is not reused, and the new row is stamped with the time it was written.
  w.control.now = first.expiresAt - 10;
  const second = waiting.issue({ jobId: job('one'), buyer: BUYER }, SCOPE, LIVE);
  assert.notEqual(second.sessionNonce, first.sessionNonce);
  assert.equal(second.expiresAt, first.expiresAt + 10 + LIFETIME);
  assert.equal(waiting.retained(second.sessionNonce).issuedAt, first.expiresAt + 10);
});

test('challenge-attempt-decides-expiry-once-the-lock-is-held', (t) => {
  const w = world(t);
  const { sessionNonce, expiresAt } = w.issue();
  const waiting = waitingLedger(w, 20);
  w.control.now = expiresAt - 10;
  assert.deepEqual(waiting.attempt(w.input(sessionNonce)), refused('context_challenge_expired'));
  assert.equal(waiting.retained(sessionNonce).attemptedAt, expiresAt + 10);
});

test('challenge-startup-stamps-the-closure-once-the-lock-is-held', (t) => {
  const w = world(t);
  const lost = w.attempted();
  w.control.now = T0 + 5;
  assert.equal(waitingLedger(w, 20, 'generation-two').closeLostValidations(), 1);
  assert.equal(w.ledger.retained(lost.nonce).failure.at, T0 + 25);
});

test('challenge-unusable-clock-once-the-lock-is-held-writes-nothing', (t) => {
  const w = world(t);
  const { sessionNonce } = w.issue();
  w.attempted('lost');
  // The clock passes the read before the lock and fails the read once it is held.
  const broken = (clock) => createSellerChallengeLedger({
    db: w.db, generation: 'generation-two', now: () => w.control.now,
    transaction(run) { w.control.now = clock; w.db.exec('BEGIN IMMEDIATE'); try { return run(); } catch (error) { w.db.exec('ROLLBACK'); throw error; } finally { w.control.now = T0; } },
    sessionState: () => null, admissionCounts: () => ({ contextRecords: 0, starts: 0, buyerStarts: () => 0 }), ready: () => true, stopped: () => false,
  });
  const before = w.rows();
  const entries = {
    issue: () => broken(MAX_SAFE).issue({ jobId: job('two'), buyer: BUYER }, SCOPE, LIVE),
    attempt: () => broken(-1).attempt(w.input(sessionNonce)),
    closeLostValidations: () => broken(1.5).closeLostValidations(),
  };
  for (const [name, run] of Object.entries(entries)) w.quiet(() => assert.throws(run, { code: 'peer_clock_invalid', status: 503 }, name));
  assert.deepEqual(w.rows(), before);
});

test('challenge-snapshot-isolation', (t) => {
  const w = world(t);
  const { nonce, owner } = w.attempted();
  assert.throws(() => { owner.attemptId = 'forged'; }, TypeError);
  const forged = { generation: owner.generation, attemptId: hash('forged attempt') };
  assert.equal(w.quiet(() => w.ledger.accept(forged, nonce, w.record(nonce))), false);
  const record = w.record(nonce);
  assert.equal(w.ledger.accept(owner, nonce, record), true);
  // The caller keeps no handle on the stored record, and the stored record keeps no handle on the caller's.
  record.admission.participants[0].claim = OTHER;
  record.buyerBundleText = 'changed';
  const first = w.ledger.retained(nonce);
  assert.equal(first.accepted.admission.participants[0].claim, BUYER);
  assert.notEqual(first.accepted.buyerBundleText, 'changed');
  assert.throws(() => { first.accepted.buyerBundleText = 'changed'; }, TypeError);
  assert.throws(() => { first.owner.attemptId = 'changed'; }, TypeError);
  assert.notEqual(w.ledger.retained(nonce), first);
  const continuation = w.attempt(nonce);
  assert.throws(() => { continuation.accepted.admission.jobId = 'changed'; }, TypeError);
  assert.equal(w.ledger.retained(nonce).accepted.admission.jobId, job('one'));
});

test('ledger-accept-job-binding-atomic-cut', (t) => {
  const w = world(t), { sessionNonce } = w.issue(), { owner } = w.attempt(sessionNonce), record = w.record(sessionNonce);
  const cuts = {
    'binding insert': "CREATE TRIGGER TEST_cut BEFORE INSERT ON kit_job_bindings BEGIN SELECT RAISE(ABORT, 'TEST cut'); END",
    'acceptance update': "CREATE TRIGGER TEST_cut BEFORE UPDATE OF state ON kit_challenges WHEN NEW.state = 'accepted' BEGIN SELECT RAISE(ABORT, 'TEST cut'); END",
  };
  for (const [point, trigger] of Object.entries(cuts)) {
    w.db.exec(trigger);
    assert.throws(() => w.ledger.accept(owner, sessionNonce, record), /TEST cut/, point);
    w.db.exec('DROP TRIGGER TEST_cut');
    w.reopen();
    assert.equal(w.ledger.retained(sessionNonce).state, 'attempted', point);
    assert.deepEqual(w.ledger.retained(sessionNonce).owner, owner, point);
    assert.equal(w.ledger.jobBinding(job('one')), null, point);
  }
  assert.equal(w.ledger.accept(owner, sessionNonce, record), true);
  w.reopen();
  assert.equal(w.ledger.retained(sessionNonce).state, 'accepted');
  assert.deepEqual(w.ledger.jobBinding(job('one')), { jobId: job('one'), nonce: sessionNonce, buyer: BUYER, presentationHash: presentationOf(sessionNonce),
    buyerBundleHash: record.buyerBundleHash, admittedAt: record.admittedAt });
});

test('a job already bound to one accepted presentation refuses a second acceptance and keeps the binding', (t) => {
  const w = world(t), first = w.issue();
  w.control.now += 1;
  const second = w.ledger.issueForOperator({ jobId: job('one'), buyer: BUYER });
  const firstOwner = w.attempt(first.sessionNonce).owner;
  const secondOwner = w.attempt(second.sessionNonce, { path: 'proposal', challengeScopeHash: null }).owner;
  assert.equal(w.ledger.accept(firstOwner, first.sessionNonce, w.record(first.sessionNonce)), true);
  const kept = w.ledger.jobBinding(job('one'));
  refusal(() => w.ledger.accept(secondOwner, second.sessionNonce, w.record(second.sessionNonce)), 'seller_job_bound');
  assert.deepEqual(w.ledger.jobBinding(job('one')), kept);
  assert.equal(w.ledger.retained(second.sessionNonce).state, 'attempted');
  assert.equal(w.ledger.recordFailed(secondOwner, second.sessionNonce, 'job_taken'), true);
  assert.equal(w.ledger.jobBinding(job('two')), null);
});

// A store written before `kit_job_bindings` existed: its accepted rows carry no binding until the ledger opens.
const priorStore = (w, generation = 'generation-two') => { w.db.exec('DROP TABLE kit_job_bindings'); w.reopen(generation); };
const operatorRequest = { jobId: job('one'), buyer: BUYER };

for (const [label, sibling] of Object.entries({
  'an operator row of the same buyer': {
    issue: (w) => w.ledger.issueForOperator(operatorRequest).sessionNonce,
    attempt: (w, nonce) => w.attempt(nonce, { path: 'proposal', challengeScopeHash: null }),
    record: (w, nonce) => w.record(nonce),
  },
  'a route row of another buyer': {
    issue: (w) => w.issue('one', OTHER).sessionNonce,
    attempt: (w, nonce) => w.attempt(nonce, { buyer: OTHER, presentationHash: presentationOf(nonce, OTHER) }),
    record: (w, nonce) => w.record(nonce, 'one', OTHER),
  },
})) {
  test(`challenge-prior-store-binds-the-job-of-an-accepted-row-so-${label.replaceAll(' ', '-')}-is-refused`, (t) => {
    const w = world(t), first = w.issue();
    w.control.now += 1;
    const nonce = sibling.issue(w);
    const { owner } = w.attempt(first.sessionNonce);
    assert.equal(w.ledger.accept(owner, first.sessionNonce, w.record(first.sessionNonce)), true);
    const written = w.ledger.jobBinding(job('one'));
    priorStore(w);
    assert.deepEqual(w.ledger.jobBinding(job('one')), written);
    const second = sibling.attempt(w, nonce);
    assert.equal(second.kind, 'validate');
    refusal(() => w.ledger.accept(second.owner, nonce, sibling.record(w, nonce)), 'seller_job_bound');
    assert.equal(w.ledger.retained(nonce).state, 'attempted');
    assert.deepEqual(w.ledger.jobBinding(job('one')), written);
    assert.equal(w.ledger.recordFailed(second.owner, nonce, 'job_taken'), true);
    w.reopen('generation-three');
    assert.deepEqual(w.ledger.jobBinding(job('one')), written, 'opening a store whose accepted rows are bound changes nothing');
  });
}

test('challenge-prior-store-binding-outlives-the-reclaimed-accepted-row', (t) => {
  const w = world(t, { limits: { maxChallenges: 2 } }), first = w.issue();
  w.control.now += 1_000;
  const nonce = w.ledger.issueForOperator(operatorRequest).sessionNonce;
  const { owner } = w.attempt(first.sessionNonce);
  assert.equal(w.ledger.accept(owner, first.sessionNonce, w.record(first.sessionNonce)), true);
  const written = w.ledger.jobBinding(job('one'));
  priorStore(w);
  const second = w.attempt(nonce, { path: 'proposal', challengeScopeHash: null });
  w.control.now = T0 + HOUR + 500;
  w.control.sessionState = (jobId) => (jobId === job('one') ? 'finalised' : null);
  w.issue('two');
  assert.equal(w.ledger.retained(first.sessionNonce), null, 'the accepted row was reclaimed');
  assert.deepEqual(w.ledger.jobBinding(job('one')), written);
  refusal(() => w.ledger.accept(second.owner, nonce, w.record(nonce)), 'seller_job_bound');
  assert.equal(w.ledger.retained(nonce).state, 'attempted');
});

test('challenge-prior-store-with-two-accepted-rows-binds-the-earliest-attempt', (t) => {
  const w = world(t), route = w.issue(), operator = w.ledger.issueForOperator(operatorRequest), third = w.issue('one', OTHER);
  const { owner } = w.attempt(route.sessionNonce);
  assert.equal(w.ledger.accept(owner, route.sessionNonce, w.record(route.sessionNonce)), true);
  // The part 02 ledger let a second row of the job be accepted: copy the first's acceptance onto it.
  w.db.prepare(`UPDATE kit_challenges SET state = 'accepted', accepted = copy.accepted, presentationHash = copy.presentationHash, owner = copy.owner
    FROM (SELECT accepted, presentationHash, owner FROM kit_challenges WHERE nonce = ?) AS copy WHERE nonce = ?`).run(route.sessionNonce, operator.sessionNonce);
  // The earlier attempt belongs to the larger nonce, so ordering by nonce alone would name the other row.
  const [later, earlier] = [route.sessionNonce, operator.sessionNonce].sort();
  w.db.prepare('UPDATE kit_challenges SET attemptedAt = ? WHERE nonce = ?').run(T0 + 20, later);
  w.db.prepare('UPDATE kit_challenges SET attemptedAt = ? WHERE nonce = ?').run(T0 + 10, earlier);
  priorStore(w);
  assert.equal(w.ledger.jobBinding(job('one')).nonce, earlier);
  const attempted = w.attempt(third.sessionNonce, { buyer: OTHER, presentationHash: presentationOf(third.sessionNonce, OTHER) });
  refusal(() => w.ledger.accept(attempted.owner, third.sessionNonce, w.record(third.sessionNonce, 'one', OTHER)), 'seller_job_bound');
  w.reopen('generation-three');
  assert.equal(w.ledger.jobBinding(job('one')).nonce, earlier);
});

// A row attempted on its origin path by its party, with `presentationHash` (default: the one `input` attempts with).
const attemptedRow = (w, origin, presentationOverride) => {
  const request = { jobId: job('one'), buyer: BUYER };
  const { sessionNonce: nonce } = origin === 'route' ? w.ledger.issue(request, SCOPE, LIVE) : w.ledger.issueForOperator(request);
  const party = origin === 'route' ? { path: 'context', challengeScopeHash: SCOPE } : { path: 'proposal', challengeScopeHash: null };
  const send = (presentationHash = presentationOf(nonce)) => w.ledger.attempt({ nonce, ...request, ...party, presentationHash });
  const hashed = presentationOverride?.(nonce);
  return { nonce, send, owner: send(hashed).owner };
};

// Each record is a different presentation than the row's own, or the row's own in bytes the callers never store.
const foreignRecords = {
  'another presentation': { record: (w, nonce) => w.record(nonce, 'one', BUYER, bundleFor(nonce, BUYER, 'other')) },
  'a bundle for another nonce': { record: (w, nonce) => w.record(nonce, 'one', BUYER, bundleFor(hash('another nonce'))), own: true },
  'a bundle presented by another buyer': { record: (w, nonce) => w.record(nonce, 'one', OTHER, bundleFor(nonce, OTHER)), own: true },
  'the presentation in non-canonical text': { record: (w, nonce) => ({ ...w.record(nonce), buyerBundleText: ` ${canonicalize(bundleFor(nonce))}` }), own: true },
  'the presentation with another bundle hash': { record: (w, nonce) => {
    const record = w.record(nonce);
    const other = identityBundleHash(bundleFor(nonce, OTHER));
    assert.notEqual(other, record.buyerBundleHash);
    return { ...record, buyerBundleHash: other, admission: { ...record.admission, buyerBundleHash: other } };
  } },
  'an admission naming an equivalent buyer, not the presenter': { record: (w, nonce) => {
    const record = w.record(nonce);
    const participants = record.admission.participants.map((entry) => (entry.role === 'buyer' ? { ...entry, claim: EQUIVALENT } : entry));
    return { ...record, admission: { ...record.admission, buyer: EQUIVALENT, participants } };
  } },
};

test('challenge-accept-stores-only-the-presentation-the-row-was-attempted-with', (t) => {
  for (const origin of ['route', 'operator']) for (const [name, { record: foreign, own }] of Object.entries(foreignRecords)) {
    const w = world(t);
    // A record whose own hash the row stored is refused for its own fault; the others for not being the attempted presentation.
    const row = attemptedRow(w, origin, own ? (nonce) => sha256Hex(foreign(w, nonce).buyerBundleText) : undefined);
    const before = w.rows();
    w.statements.length = 0;
    assert.throws(() => w.ledger.accept(row.owner, row.nonce, foreign(w, row.nonce)), { code: 'context_challenge_attempt_invalid', status: 409 }, `${origin}: ${name} is refused`);
    assert.deepEqual([w.mutations(), w.rows()], [[], before], `${origin}: ${name} changes nothing`);
    assert.deepEqual([w.ledger.retained(row.nonce).state, w.ledger.retained(row.nonce).owner], ['attempted', row.owner], `${origin}: ${name} leaves the row attempted`);
    if (own) continue;
    // The exact presentation is still accepted afterwards, and a replay of the stored hash answers it.
    const exact = w.record(row.nonce);
    assert.equal(w.ledger.accept(row.owner, row.nonce, exact), true, `${origin}: ${name} then the exact record`);
    assert.deepEqual(w.quiet(() => row.send()), { kind: 'continuation', accepted: exact }, `${origin}: ${name} then a replay`);
  }
});

test('challenge-accepted-record-that-does-not-match-its-row-is-unavailable-after-reopening', (t) => {
  for (const origin of ['route', 'operator']) {
    const w = world(t);
    const row = attemptedRow(w, origin);
    const exact = w.record(row.nonce);
    assert.equal(w.ledger.accept(row.owner, row.nonce, exact), true);
    const other = w.record(row.nonce, 'one', BUYER, bundleFor(row.nonce, BUYER, 'other'));
    w.db.prepare('UPDATE kit_challenges SET accepted = ? WHERE nonce = ?').run(JSON.stringify(other), row.nonce);
    assert.deepEqual(w.quiet(() => row.send()), refused('session_admission_unavailable', 503), `${origin}: the origin path live`);
    w.reopen('generation-two');
    assert.deepEqual(w.quiet(() => row.send()), refused('session_admission_unavailable', 503), `${origin}: the origin path reopened`);
    if (origin === 'route') {
      const proposal = { nonce: row.nonce, jobId: job('one'), buyer: BUYER, challengeScopeHash: SCOPE, presentationHash: presentationOf(row.nonce), path: 'proposal' };
      assert.deepEqual(w.quiet(() => w.ledger.attempt(proposal)), refused('session_admission_unavailable', 503), 'the proposal continuation');
    }
  }
});

test('challenge-accepted-presentation-answers-an-equivalent-buyer', (t) => {
  const w = world(t);
  const row = attemptedRow(w, 'route');
  const exact = w.record(row.nonce);
  assert.equal(w.ledger.accept(row.owner, row.nonce, exact), true);
  const equivalent = { nonce: row.nonce, jobId: job('one'), buyer: EQUIVALENT, challengeScopeHash: SCOPE, presentationHash: presentationOf(row.nonce), path: 'context' };
  assert.deepEqual(w.quiet(() => w.ledger.attempt(equivalent)), { kind: 'continuation', accepted: exact });
});

test('challenge-issuance-refuses-a-session-state-that-cannot-be-read', (t) => {
  const readers = {
    throws: [() => { throw new Error('state unavailable'); }, /state unavailable/],
    promise: [() => Promise.resolve('finalised'), TypeError],
    'rejected promise': [() => Promise.reject(new Error('late')), TypeError],
    object: [() => ({ state: 'finalised' }), TypeError],
    number: [() => 42, TypeError],
    undefined: [() => undefined, TypeError],
  };
  const entries = {
    issue: (w) => w.issue(),
    issueForOperator: (w) => w.ledger.issueForOperator({ jobId: job('one'), buyer: BUYER }),
  };
  const unavailable = (error) => error.code === 'session_admission_unavailable' && error.status === 503;
  for (const [entry, issue] of Object.entries(entries)) for (const [name, [reader, expected]] of Object.entries(readers)) {
    const label = `${entry} ${name}`;
    const w = world(t);
    w.control.sessionState = reader;
    w.quiet(() => assert.throws(() => issue(w), (error) => unavailable(error) && (expected instanceof RegExp ? expected.test(error.cause?.message) : error.cause instanceof expected), label));
    assert.deepEqual(w.rows(), [], label);
    assert.equal(w.control.countReads, 0, `${label} refuses at step 7, before the counts`);

    // A live nonce is not handed back once the job's state can no longer be read, also after a restart.
    w.control.sessionState = () => null;
    const first = issue(w);
    w.control.sessionState = reader;
    w.quiet(() => assert.throws(() => issue(w), unavailable, `${label} reuse`));
    w.reopen('generation-two');
    w.quiet(() => assert.throws(() => issue(w), unavailable, `${label} reuse after restart`));
    assert.deepEqual(w.rows().map((row) => row.nonce), [first.sessionNonce], label);
  }
});

test('challenge-issuance-still-permits-a-null-or-nonterminal-session-state', (t) => {
  const w = world(t);
  for (const [label, state] of [['one', null], ['two', 'negotiating']]) {
    w.control.sessionState = () => state;
    assert.ok(w.issue(label).sessionNonce, String(state));
  }
  w.control.sessionState = () => 'finalised';
  quietRefusal(w, () => w.issue('three'), 'context_session_terminal', 409);
});
