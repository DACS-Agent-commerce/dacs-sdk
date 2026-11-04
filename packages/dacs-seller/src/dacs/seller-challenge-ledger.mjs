// The kit's one durable challenge ledger (K1). It issues seller challenge nonces, consumes a nonce on
// its first authenticated presentation attempt, records which attempt owns the validation, and keeps
// either the one accepted presentation with its admission or the definite refusal.
// Unwired until P09a2a: nothing in the host, the routes or the agent calls it. The caller owns the
// SQLite handle, the immediate-transaction helper, the startup lock and the terminal-state view.
import { randomBytes, randomUUID } from 'node:crypto';
import { isCanonicalClaimReference, isCanonicalJobId, sameCanonicalClaimIdentity } from '@kynesyslabs/dacs';
import { assertKitOperationAdmitted } from '../kit-operation-guard.mjs';
import { SESSION_CHALLENGE_LIFETIME_MS, sessionAdmissionProblem } from './session-admission.mjs';
import { SellerTransportError, TERMINAL_CONTEXT_STATES } from './seller-transport-auth.mjs';

const CHALLENGE_WINDOW_MS = 3_600_000;
/** The ledger's limits and their defaults; `limits` may override any of these names. */
export const CHALLENGE_LIMIT_DEFAULTS = Object.freeze({
  maxChallenges: 10_000, maxContextRecords: 10_000, maxPerBuyerPerHour: 5, maxPerHour: 12, maxPerJob: 16,
  maxStartsPerBuyerPerHour: 5, maxStartsPerHour: 12,
});
const ACCEPTED_KEYS = ['admission', 'admittedAt', 'buyerBundleHash', 'buyerBundleText', 'firstAdmission'];
const FIRST_ADMISSION_KEYS = ['challengeExpiresAt', 'checkedAt', 'generatedAt'];
const HASH = /^[0-9a-f]{64}$/;

const isHash = (value) => typeof value === 'string' && HASH.test(value);
const isUint = (value) => Number.isSafeInteger(value) && value >= 0;
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, sortedKeys) => isRecord(value) && Object.keys(value).sort().join() === sortedKeys.join();
const fail = (code, status = 409) => { throw new SellerTransportError(code, status); };
const refused = (code, status = 409, cause) => Object.freeze({ kind: 'refused', code, status, ...(cause === undefined ? {} : { cause }) });
const answerOf = ({ nonce, expiresAt }) => Object.freeze({ sessionNonce: nonce, expiresAt });
const ownerText = (owner) => (isRecord(owner) && typeof owner.generation === 'string' && owner.generation !== '' && typeof owner.attemptId === 'string' && owner.attemptId !== ''
  ? JSON.stringify({ generation: owner.generation, attemptId: owner.attemptId }) : null);
// A stored column that cannot be read back never matches or answers anything.
const parseColumn = (text) => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

// No asynchronous work may run inside SQLite: a promise is refused, and a rejected one is handled.
function requireSynchronous(value, name) {
  if (typeof value?.then !== 'function') return value;
  Promise.resolve(value).catch(() => {});
  throw new TypeError(`${name} must answer synchronously`);
}

const readCount = (value, name) => {
  if (!isUint(value)) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value;
};

// The guard names its entry, so each issue entry reports its own name.
function assertIssueAdmitted(origin) {
  if (origin === 'route') assertKitOperationAdmitted('issue');
  else assertKitOperationAdmitted('issueForOperator');
}

function validateIssueRequest(request, challengeScopeHash, origin) {
  if (!isRecord(request) || !isCanonicalJobId(request.jobId)) fail('peer_job_invalid');
  const unknownMember = Object.keys(request).some((key) => key !== 'jobId' && key !== 'buyer');
  if (unknownMember || !isCanonicalClaimReference(request.buyer) || (origin === 'route' && !isHash(challengeScopeHash))) fail('context_scope_invalid');
}

// Whether the retained admission still binds this row's job and buyer and the record's own bundle hash.
function admissionBindsRow(admission, buyerBundleHash, row) {
  if (!isRecord(admission) || admission.jobId !== row.jobId || !sameCanonicalClaimIdentity(admission.buyer, row.buyer)) return false;
  const participants = Array.isArray(admission.participants) ? admission.participants : [];
  const seller = participants.find((entry) => entry?.role === 'seller')?.claim;
  return sessionAdmissionProblem(admission, { jobId: row.jobId, buyer: admission.buyer, buyerBundleHash, seller, listingPin: admission.listingPin }) === null;
}

function acceptedIsComplete(accepted, row) {
  if (!hasExactKeys(accepted, ACCEPTED_KEYS) || typeof accepted.buyerBundleText !== 'string' || !isHash(accepted.buyerBundleHash) || !isUint(accepted.admittedAt)
    || !hasExactKeys(accepted.firstAdmission, FIRST_ADMISSION_KEYS) || !FIRST_ADMISSION_KEYS.every((key) => isUint(accepted.firstAdmission[key]))) return false;
  try { if (!isRecord(JSON.parse(accepted.buyerBundleText))) return false; } catch { return false; }
  return admissionBindsRow(accepted.admission, accepted.buyerBundleHash, row);
}

// The text to store for `record`: its own JSON form, checked as stored so the caller keeps no handle on it.
function acceptedText(record, row) {
  try {
    const text = JSON.stringify(record);
    return acceptedIsComplete(JSON.parse(text), row) ? text : null;
  } catch { return null; }
}

// The attempt as every answer compares it, each field read once: an absent scope is null, and a presentation hash that is not 64 lowercase hex is null.
const normaliseAttempt = ({ nonce, jobId, buyer, challengeScopeHash, presentationHash, path }) => ({
  nonce, jobId, buyer, path, challengeScopeHash: challengeScopeHash ?? null, presentationHash: isHash(presentationHash) ? presentationHash : null,
});

// Whether the attempt is the row's own party: its job, scope and canonical buyer, on the path of the row's origin.
const ORIGIN_PATHS = Object.freeze({ route: 'context', operator: 'proposal' });
const isRowParty = (row, input) => input.path === ORIGIN_PATHS[row.origin] && input.jobId === row.jobId
  && input.challengeScopeHash === row.challengeScopeHash && sameCanonicalClaimIdentity(row.buyer, input.buyer);

// K1 attempt step 7 on an `issued` row: the code the first attempt fails with, or null when it may validate.
function firstAttemptRefusal(row, input, time) {
  if (!isRowParty(row, input)) return 'context_challenge_mismatch';
  if (time >= row.expiresAt) return 'context_challenge_expired';
  return input.presentationHash === null ? 'context_challenge_attempt_invalid' : null;
}

function continuation(row) {
  return acceptedIsComplete(row.accepted, row) ? Object.freeze({ kind: 'continuation', accepted: row.accepted }) : refused('session_admission_unavailable', 503);
}

// The stored answer of a row past `issued`, by state. Each receives a row its party has already matched.
const REPLAY_ANSWERS = Object.freeze({
  accepted: continuation,
  attempted: () => refused('context_attempt_pending', 503),
  failed: (row) => refused('context_challenge_failed', 409, row.failure?.code),
});

// A row past `issued` answers only its own party presenting the stored presentation hash; anyone else, or a state with no answer, finds it consumed.
function replayAnswer(row, input) {
  const matched = isRowParty(row, input) && input.presentationHash === row.presentationHash && Object.hasOwn(REPLAY_ANSWERS, row.state);
  return matched ? REPLAY_ANSWERS[row.state](row) : refused('context_challenge_consumed');
}

/**
 * Creates the challenge ledger on the caller's SQLite handle and returns a frozen API.
 * `transaction(fn, rollback = false)` runs fn synchronously in BEGIN IMMEDIATE and returns its result.
 * `now()` is the seller clock in ms; `generation` identifies this process, drawn after the seller state
 * lock is held. `sessionState({ jobId })` is synchronous; anything but a string (a throw, a promise)
 * counts as an unknown state. `admissionCounts()` returns `{ contextRecords, starts, buyerStarts(buyer) }`
 * over durable rows. `ready()` and `stopped()` are synchronous booleans; anything else fails closed.
 * Entries: `issue(request, challengeScopeHash, authorization)` and `issueForOperator(request)` return
 * `{ sessionNonce, expiresAt }` or throw SellerTransportError (a guard refusal keeps its own class);
 * `authorization.assertStillLive()` is the route's final synchronous request and delegation expiry check;
 * it, the guard and the stop check also run before a reused live nonce is returned.
 * `attempt(input)` returns `{ kind: 'validate', owner }`, `{ kind: 'continuation', accepted }` or
 * `{ kind: 'refused', code, status, cause? }`. The row's party is its job, scope (absent counts as null) and
 * canonical buyer on the path of its origin (`context` for a route row, `proposal` for an operator row).
 * An `accepted`, `attempted` or `failed` row answers its continuation, `context_attempt_pending` or
 * `context_challenge_failed` with the stored cause only to its party with the stored presentation hash;
 * anyone else gets `context_challenge_consumed` and nothing is written. A first attempt by anyone but the
 * party fails the row as `context_challenge_mismatch`, except a route row on `proposal`, which is refused
 * unchanged. Throws if the row changed under the lock. `accept` and `recordFailed` return whether the row was
 * `attempted` by that owner and changed; their `Within` forms need an open transaction and open none.
 * `closeLostValidations()` returns how many earlier-generation attempts it closed. `retained(nonce)`
 * returns a detached frozen row or null; its caller compares the buyer and the exact bundle bytes.
 * Construction throws TypeError for an unusable port, generation or limit.
 */
export function createSellerChallengeLedger({ db, transaction, now, generation, limits = {}, sessionState, admissionCounts, ready, stopped }) {
  const capacity = { ...CHALLENGE_LIMIT_DEFAULTS, ...limits };
  const ports = [transaction, now, sessionState, admissionCounts, ready, stopped];
  if (!ports.every((port) => typeof port === 'function' && port.constructor.name !== 'AsyncFunction') || typeof generation !== 'string' || generation === ''
    || !Object.keys(limits).every((name) => Object.hasOwn(CHALLENGE_LIMIT_DEFAULTS, name)) || !Object.values(capacity).every((value) => isUint(value) && value > 0)) {
    throw new TypeError('the challenge ledger needs synchronous ports, a generation and positive known limits');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS kit_challenges (
    nonce TEXT PRIMARY KEY, jobId TEXT NOT NULL, buyer TEXT NOT NULL, challengeScopeHash TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('route', 'operator')), issuedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('issued', 'attempted', 'accepted', 'failed')),
    presentationHash TEXT, owner TEXT, attemptedAt INTEGER, failure TEXT, accepted TEXT);
    CREATE INDEX IF NOT EXISTS kit_challenges_job ON kit_challenges(jobId)`);
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args).changes;

  function readClock(headroomMs = 0) {
    const time = now();
    if (!isUint(time) || !isUint(time + headroomMs)) fail('peer_clock_invalid', 503);
    return time;
  }

  function requireOpenTransaction(entry) {
    if (!db.inTransaction) throw new TypeError(`${entry} runs inside an open transaction`);
  }

  // Only an exact terminal state answers true; the source is unknown, never trusted, when it throws or is not synchronous.
  function isTerminal(jobId) {
    try {
      const state = requireSynchronous(sessionState({ jobId }), 'sessionState');
      return typeof state === 'string' && TERMINAL_CONTEXT_STATES.has(state);
    } catch { return false; }
  }

  function retained(nonce) {
    const row = isHash(nonce) ? one('SELECT * FROM kit_challenges WHERE nonce = ?', nonce) : undefined;
    return row ? deepFreeze({ ...row, owner: parseColumn(row.owner), failure: parseColumn(row.failure), accepted: parseColumn(row.accepted) }) : null;
  }

  // K1 steps 10-12: the rolling-hour limits and the per-job count.
  function enforceIssuanceLimits(buyer, jobCount, time) {
    const recent = all('SELECT buyer FROM kit_challenges WHERE issuedAt > ?', time - CHALLENGE_WINDOW_MS);
    if (recent.length >= capacity.maxPerHour) fail('context_challenge_limit', 429);
    if (recent.filter((row) => sameCanonicalClaimIdentity(row.buyer, buyer)).length >= capacity.maxPerBuyerPerHour) fail('buyer_context_challenge_limit', 429);
    if (jobCount >= capacity.maxPerJob) fail('context_challenge_capacity', 503);
  }

  // K1 step 13: the nonces to delete so the new row fits, chosen before anything is deleted.
  function planReclamation(time) {
    const needed = one('SELECT COUNT(*) AS n FROM kit_challenges').n - capacity.maxChallenges + 1;
    if (needed <= 0) return [];
    const plan = [];
    for (const row of all('SELECT nonce, jobId FROM kit_challenges WHERE expiresAt <= ? AND issuedAt <= ? ORDER BY issuedAt', time, time - CHALLENGE_WINDOW_MS)) {
      if (isTerminal(row.jobId)) plan.push(row.nonce);
      if (plan.length === needed) return plan;
    }
    fail('context_challenge_capacity', 503);
  }

  // K1 steps 14-15: the context-record count, then the unpaid start counts.
  function enforceAdmissionLimits(buyer) {
    const counts = requireSynchronous(admissionCounts(), 'admissionCounts');
    if (!isRecord(counts) || typeof counts.buyerStarts !== 'function') throw new TypeError('admissionCounts must answer { contextRecords, starts, buyerStarts(buyer) }');
    if (readCount(counts.contextRecords, 'contextRecords') >= capacity.maxContextRecords) fail('peer_context_capacity', 503);
    if (readCount(counts.starts, 'starts') >= capacity.maxStartsPerHour) fail('unpaid_start_limit', 429);
    if (readCount(requireSynchronous(counts.buyerStarts(buyer), 'buyerStarts'), 'buyerStarts') >= capacity.maxStartsPerBuyerPerHour) fail('buyer_unpaid_start_limit', 429);
  }

  // K1 step 16, for a new and a reused nonce alike: the guard and the stop again, then the route's final expiry check.
  function assertStillAllowed(origin, authorization) {
    assertIssueAdmitted(origin);
    if (stopped() !== false) fail('seller_stopped', 503);
    if (origin === 'route') requireSynchronous(authorization.assertStillLive(), 'assertStillLive');
  }

  // K1 steps 7-17, inside the transaction: every refusal is decided before the first write.
  function issueInTransaction({ jobId, buyer }, challengeScopeHash, origin, authorization, time) {
    if (isTerminal(jobId)) fail('context_session_terminal');
    const jobRows = all('SELECT * FROM kit_challenges WHERE jobId = ?', jobId);
    if (jobRows.some((row) => row.state !== 'issued')) fail('context_job_closed');
    const live = jobRows.find((row) => row.expiresAt > time && row.challengeScopeHash === challengeScopeHash && sameCanonicalClaimIdentity(row.buyer, buyer));
    let reclaimed = [];
    if (!live) {
      enforceIssuanceLimits(buyer, jobRows.length, time);
      reclaimed = planReclamation(time);
      enforceAdmissionLimits(buyer);
    }
    // A reused nonce is answered only while the seller may still answer: it skips the counts and the writes, not step 16.
    assertStillAllowed(origin, authorization);
    if (live) return answerOf(live);
    const nonce = randomBytes(32).toString('hex');
    const expiresAt = time + SESSION_CHALLENGE_LIFETIME_MS;
    for (const stale of reclaimed) run('DELETE FROM kit_challenges WHERE nonce = ?', stale);
    run(`INSERT INTO kit_challenges (nonce, jobId, buyer, challengeScopeHash, origin, issuedAt, expiresAt, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'issued')`, nonce, jobId, buyer, challengeScopeHash, origin, time, expiresAt);
    return answerOf({ nonce, expiresAt });
  }

  function issueChallenge(origin, request, challengeScopeHash, authorization) {
    assertIssueAdmitted(origin);
    validateIssueRequest(request, challengeScopeHash, origin);
    if (origin === 'route' && typeof authorization?.assertStillLive !== 'function') throw new TypeError('issue needs the final-liveness closure assertStillLive');
    // K1 step 6 refuses an unusable clock before the lock is taken. The lock can be waited for: expiry,
    // reuse and the written times use the clock read again once it is held.
    readClock(SESSION_CHALLENGE_LIFETIME_MS);
    return transaction(() => issueInTransaction(request, challengeScopeHash ?? null, origin, authorization, readClock(SESSION_CHALLENGE_LIFETIME_MS)));
  }

  // A transition the lock guarantees changes exactly one row; anything else throws so the caller's transaction rolls back.
  function changeOne(sql, ...args) {
    if (run(sql, ...args) !== 1) throw new Error('the challenge row changed under the ledger lock');
  }

  // K1 attempt steps 1-7; the order of these answers is the contract.
  function attemptInTransaction(input, time) {
    const row = retained(input.nonce);
    if (row === null) return refused('context_challenge_mismatch');
    if (row.state !== 'issued') return replayAnswer(row, input);
    if (ready() !== true) return refused('seller_not_ready', 503);
    if (input.path === 'proposal' && row.origin === 'route') return refused('context_challenge_mismatch');
    const code = firstAttemptRefusal(row, input, time);
    if (code !== null) {
      changeOne("UPDATE kit_challenges SET state = 'failed', presentationHash = ?, attemptedAt = ?, failure = ? WHERE nonce = ? AND state = 'issued'",
        input.presentationHash, time, JSON.stringify({ code, status: 409, at: time }), row.nonce);
      return refused(code);
    }
    const owner = Object.freeze({ generation, attemptId: randomUUID() });
    changeOne("UPDATE kit_challenges SET state = 'attempted', presentationHash = ?, owner = ?, attemptedAt = ? WHERE nonce = ? AND state = 'issued'",
      input.presentationHash, ownerText(owner), time, row.nonce);
    return Object.freeze({ kind: 'validate', owner });
  }

  function attempt(input) {
    if (!isRecord(input) || (input.path !== 'context' && input.path !== 'proposal')) throw new TypeError('attempt needs an input naming its path, context or proposal');
    const normalised = normaliseAttempt(input);
    readClock();
    return transaction(() => attemptInTransaction(normalised, readClock()));
  }

  // The row this exact attempt owns, or null: only this generation's owner can ever advance a validation.
  function ownedAttempt(owner, nonce) {
    const text = ownerText(owner);
    if (text === null || owner.generation !== generation || !isHash(nonce)) return null;
    return one("SELECT * FROM kit_challenges WHERE nonce = ? AND state = 'attempted' AND owner = ?", nonce, text) ?? null;
  }

  function acceptWithin(owner, nonce, record) {
    requireOpenTransaction('acceptWithin');
    const row = ownedAttempt(owner, nonce);
    if (row === null) return false;
    const text = acceptedText(record, row);
    if (text === null) fail('context_challenge_attempt_invalid');
    return run("UPDATE kit_challenges SET state = 'accepted', accepted = ? WHERE nonce = ? AND state = 'attempted' AND owner = ?", text, nonce, row.owner) === 1;
  }

  function recordFailedWithin(owner, nonce, code, status = 409) {
    requireOpenTransaction('recordFailedWithin');
    if (typeof code !== 'string' || code === '' || !Number.isInteger(status) || status < 400 || status > 599) fail('context_challenge_attempt_invalid');
    const row = ownedAttempt(owner, nonce);
    if (row === null) return false;
    return run("UPDATE kit_challenges SET state = 'failed', failure = ? WHERE nonce = ? AND state = 'attempted' AND owner = ?",
      JSON.stringify({ code, status, at: readClock() }), nonce, row.owner) === 1;
  }

  function closeLostValidations() {
    readClock();
    return transaction(() => run("UPDATE kit_challenges SET state = 'failed', failure = ? WHERE state = 'attempted' AND json_extract(owner, '$.generation') IS NOT ?",
      JSON.stringify({ code: 'validator_lost', status: 409, at: readClock() }), generation));
  }

  return Object.freeze({
    issue: (request, challengeScopeHash, authorization) => issueChallenge('route', request, challengeScopeHash, authorization),
    issueForOperator: (request) => issueChallenge('operator', request, null),
    attempt,
    accept: (owner, nonce, record) => transaction(() => acceptWithin(owner, nonce, record)),
    acceptWithin,
    recordFailed: (owner, nonce, code, status) => transaction(() => recordFailedWithin(owner, nonce, code, status)),
    recordFailedWithin,
    closeLostValidations,
    retained,
  });
}
