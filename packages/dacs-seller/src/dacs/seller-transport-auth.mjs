// The seller's transport store and the Agreement-context scope helpers; the wire authenticates each request.
import { randomBytes } from 'node:crypto';
import { constants, closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import { canonicalize, createFixedPriceAgreementSigningPlan, isCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { DACS_SELLER_HTTP_PATHS as PATHS, DACS_SELLER_HTTP_LIMITS, isTp1WireProfile, wireOperationBinding } from '@kynesyslabs/dacs/wire';
import { createSellerChallengeLedger } from './seller-challenge-ledger.mjs';
import { assertKitOperationAdmitted, kitOperationAdmitted } from '../kit-operation-guard.mjs';
import { createReservationAccounting } from './seller-reservation-accounting.mjs';
import { dropEmptyObsoleteTables } from './seller-obsolete-store-tables.mjs';

const MAX_TRANSPORT_LIFETIME_MS = 60_000;
const HASH = /^[0-9a-f]{64}$/;
const isHash = value => typeof value === 'string' && HASH.test(value);
const PROPOSAL = '/dacs/v1/agreements/proposals';
const STATE = '/dacs/v1/agreements/state';
const PAYMENT = '/dacs/v1/payments';
// The Vet and Agreement-context step (seller context route) precedes the
// Agreement, so its envelope carries the hash of the exact context scope in
// the agreementHash slot. It never binds the job's Agreement in peer_jobs.
// Presentations use a seller-issued, durable, single-use challenge bound to
// the context scope without its bundle hash. Exact retained-effect retries
// read their old answer; they never admit another presentation.
const CONTEXT = PATHS.context;
// The plugin's Agreement-context scope without its own account and operation ids.
export const SELLER_CONTEXT_SCOPE_KEYS = Object.freeze(['source', 'wallet', 'jobId', 'buyer', 'buyerBundleHash', 'seller', 'listingPin', 'rail', 'payee', 'price', 'generatedAt']);
export const sellerContextChallengeScope = (value) => { requireJobId(value?.jobId); const { buyerBundleHash, ...scope } = value; return scope; };
export const sellerContextScopeHash = (scope) => { requireJobId(scope?.jobId); return sha256Hex(canonicalize(scope)); };
const READ_ROUTES = new Set([STATE, '/dacs/v1/bundles/buyer-copy']);
const exact = (a, b) => canonicalize(a) === canonicalize(b);
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, expected) => record(v) && Object.keys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k));
const uint = (v) => Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);
const fail = (code, status = 401) => { throw new SellerTransportError(code, status); };
function requireJobId(jobId) {
  if (!isCanonicalJobId(jobId)) fail('peer_job_invalid', 409);
}

/** Transport refusal with a stable code, HTTP status and optional original cause. */
export class SellerTransportError extends Error {
  constructor(code, status = 401, options) { super(code, options); this.code = code; this.status = status; }
}

/** Internal synchronous session read: returns a state or null; throws unavailable 503 with the original cause. */
export function readSellerSessionState(source, jobId) {
  try {
    const state = source({ jobId });
    if (state === null || typeof state === 'string') return state;
    if (typeof state?.then === 'function') Promise.resolve(state).then(undefined, () => {});
    throw new TypeError('sessionState must answer a state string or null', { cause: state });
  } catch (cause) {
    if (cause instanceof SellerTransportError && cause.code === 'session_admission_unavailable' && cause.status === 503) throw cause;
    throw new SellerTransportError('session_admission_unavailable', 503, { cause });
  }
}

/** True for a Listing pin of exactly `{ listingId, version, contentHash }` with a non-empty id, a positive version and a SHA-256 hex hash. */
export function pinValid(pin) {
  return keys(pin, ['listingId', 'version', 'contentHash']) &&
    typeof pin.listingId === 'string' && pin.listingId.length > 0 && pin.listingId.length <= 256 &&
    uint(pin.version) && pin.version > 0 && typeof pin.contentHash === 'string' && isHash(pin.contentHash);
}

function requestIdentity(p) {
  requireJobId(p?.jobId);
  return { jobId: p.jobId, buyer: p.buyer, seller: p.seller, listingPin: p.listingPin, agreementHash: p.agreementHash };
}

/**
 * The seller's own checks of an authenticated request's body against the request's payload (the wire leaves them to the
 * seller): the job and identity it names, and the proposal or payment it carries. Returns nothing; throws a SellerTransportError.
 */
export function validateBody(p, body) {
  if (!record(body)) fail('peer_body_invalid', 409);
  if (p.path === PATHS.contextChallenge) {
    if (!keys(body, ['scope']) || !keys(body.scope, SELLER_CONTEXT_SCOPE_KEYS.filter(k => k !== 'buyerBundleHash')) ||
        body.scope.jobId !== p.jobId || body.scope.buyer !== p.buyer || body.scope.seller !== p.seller ||
        !exact(body.scope.listingPin, p.listingPin) || sellerContextScopeHash(body.scope) !== p.agreementHash) fail('peer_context_mismatch', 409);
    return;
  }
  if (p.path === CONTEXT) {
    const scope = body.scope;
    if (!record(scope) || scope.jobId !== p.jobId) fail('peer_job_mismatch', 409);
    if (!keys(body, ['scope', 'buyerIdentityBundle']) || !keys(scope, SELLER_CONTEXT_SCOPE_KEYS) || scope.buyer !== p.buyer || scope.seller !== p.seller ||
        !exact(scope.listingPin, p.listingPin) || body.buyerIdentityBundle?.presentedBy !== p.buyer || sellerContextScopeHash(scope) !== p.agreementHash) fail('peer_context_mismatch', 409);
    return;
  }
  const identity = body.transportIdentity;
  // A body that names its job twice names the signed one both times, whichever field a consumer reads.
  const namedJobs = [identity?.jobId, body.jobId].filter((named) => named !== undefined);
  if (namedJobs.length === 0 || namedJobs.some((named) => named !== p.jobId)) fail('peer_job_mismatch', 409);
  if (p.path === PROPOSAL || p.path === STATE) {
    if (!record(identity) || identity.buyer !== p.buyer || identity.seller !== p.seller || identity.agreementHash !== p.agreementHash) fail('peer_agreement_mismatch', 409);
  }
  if (p.path === PROPOSAL) {
    const proposal = body.proposal;
    let plan;
    try { plan = createFixedPriceAgreementSigningPlan(proposal?.plan?.draft); } catch { fail('peer_proposal_invalid', 422); }
    const material = { proposalVersion: proposal.proposalVersion, plan: proposal.plan, buyerContribution: proposal.buyerContribution };
    if (!exact(plan, proposal.plan) || plan.draft.jobId !== p.jobId || !exact(plan.draft.listingRef, p.listingPin) ||
        plan.agreementHash !== p.agreementHash || plan.planHash !== identity.planHash ||
        proposal.proposalHash !== identity.proposalHash || sha256Hex(canonicalize(material)) !== identity.proposalHash ||
        body.buyerIdentityBundle?.presentedBy !== p.buyer ||
        !exact(plan.requiredSigners, [{ role: 'buyer', party: p.buyer }, { role: 'seller', party: p.seller }])) fail('peer_proposal_mismatch', 409);
  }
  if (p.path === PAYMENT && (body.payerPayingKey !== p.buyer || typeof body.txHash !== 'string' || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(body.txHash))) fail('peer_payment_mismatch', 409);
}

// Durable intent precedes effects; ambiguous work stays fenced across restart.
// Lazy context admissions own pre-Agreement jobs and their unpaid-start limits.
const CONTEXT_EFFECT_INDEX = 'CREATE INDEX IF NOT EXISTS peer_context_admissions_effect ON peer_context_admissions(effect)';

// Trusted seller state retains terminal ownership; unknown state retains challenges.
// Read-only membership test for the challenge ledger; nothing may add to it.
export const TERMINAL_CONTEXT_STATES = new Set(['finalised', 'vet-failed', 'negotiate-failed', 'commit-failed', 'settle-failed', 'aborted-by-self', 'aborted-by-other', 'failed-substrate']);
const CHALLENGE_RATE_WINDOW_MS = 3600000;
const CLOSURE_SOURCES = new Set(['cleanup', 'effect-path', 'session-observer']);
const NOT_TERMINAL = Object.freeze({ terminal: false, state: null });
const storeInternals = new WeakMap();
// The version `bind` writes into the store's binding.
const STORE_VERSION = '1';
/**
 * The one list of the records behind each reservation limit. Reservation accounting counts only these, so
 * a record any of these tables holds counts against every limit. Each source selects `job`, or a unit's
 * `buyer` and `at`; an owner source also selects the buyer, seller and Listing pin that hold the job.
 * Total records are the accounting rows that still count (see RETIRABLE_RESERVATION).
 */
export const RESERVATION_LEDGER = Object.freeze({
  buyerUnits: Object.freeze(['SELECT buyer, at FROM kit_reservations']),
  jobs: Object.freeze(['SELECT job FROM peer_jobs', 'SELECT job FROM peer_context_admissions', 'SELECT jobId AS job FROM kit_job_holds', 'SELECT jobId AS job FROM kit_context_admissions']),
  contextRecords: Object.freeze(['SELECT job FROM peer_context_admissions', 'SELECT jobId AS job FROM kit_job_holds WHERE context = 1', 'SELECT jobId AS job FROM kit_context_admissions']),
  owners: Object.freeze([
    'SELECT job, buyer, seller, pin FROM kit_job_owners',
    "SELECT job, json_extract(context, '$.buyer') AS buyer, json_extract(context, '$.seller') AS seller, json_extract(context, '$.listingPin') AS pin FROM peer_jobs",
    'SELECT job, buyer, seller, listing_pin AS pin FROM peer_context_admissions',
    'SELECT jobId AS job, buyer, seller, listing_pin AS pin FROM kit_job_holds',
    "SELECT job, json_extract(owner, '$.buyer') AS buyer, json_extract(owner, '$.seller') AS seller, json_extract(owner, '$.listingPin') AS pin FROM kit_slot_retirements WHERE owner IS NOT NULL",
    "SELECT jobId AS job, buyer, json_extract(record, '$.seller') AS seller, json_extract(record, '$.listingPin') AS pin FROM kit_context_admissions"]),
});
const NO_DELEGATION = Object.freeze({ assertStillLive: () => {} });
// The default unpaid-start limits: five accepted starts per buyer per rolling hour, and 12 overall, which fill the default 24 policy writes
// an hour (operator-approval.mjs SELLER_POLICY_DEFAULTS) at two Vet CREATEs a start. They count the durable admission records, so only
// accepted new starts count, also after a restart.
const SELLER_CONTEXT_START_LIMITS = Object.freeze({ maxStartsPerHour: 12, maxStartsPerBuyerPerHour: 5 });
/**
 * Opens the private transport journal and the one challenge ledger on its SQLite handle.
 * `generation` names this process (drawn after the seller state lock), `ready` and `stopped` are
 * synchronous booleans, `contextSessionState({ jobId })` is the host's raw synchronous port (DACS-5 name or unknown) that only this
 * store reads, through the one observation adapter (`sellerStoreInternals(store).sessionState`), and
 * `contextStartLimits` are the route's own unpaid-start limits, which the ledger enforces too.
 * `contextRecords` is the counter step 4 of reservation accounting reads; it defaults to the union of the
 * retained context records (old admissions and K1 rows, intent rows included), and only tests replace it.
 * `retainsUnfinishedWork({ jobId, path })` is synchronous and says whether the seller keeps work a retry
 * on that route must finish; an operation that ended without a stored answer lets its job retire only when
 * it answers false, so never when it throws or is not given.
 * Returns the store, whose `challenges` is the ledger; `recoverLostContextReservations()` runs only
 * while the caller holds the seller state lock. Throws on an unusable option or storage.
 */
export function createSellerTransportStore({ path, maxRecords = 10000, maxJobs = maxRecords, maxChallenges = maxRecords, maxContextRecords = maxRecords, contextSessionState: readSessionState = () => null,
  contextStartLimits = SELLER_CONTEXT_START_LIMITS, generation = randomBytes(16).toString('hex'), ready = () => true, stopped = () => false,
  maxNoncesPerBuyerPerWindow = 120, nonceWindowMs = 60000, now = () => Date.now(), contextRecords, wireOperationView = () => null, retainsUnfinishedWork = () => true }) {
  if (typeof path !== 'string' || !isAbsolute(path) || !uint(maxRecords) || maxRecords === 0) throw new Error('a persistent absolute path and positive store capacity are required');
  if (!uint(maxJobs) || maxJobs === 0) throw new Error('positive job capacity required');
  if (!uint(maxChallenges) || maxChallenges === 0 || typeof readSessionState !== 'function') throw new Error('positive challenge capacity and seller session-state reader required');
  if (typeof wireOperationView !== 'function' || typeof retainsUnfinishedWork !== 'function') throw new Error('wire operation and unfinished work readers must be functions');
  if (!uint(maxContextRecords) || maxContextRecords === 0) throw new Error('positive context capacity required');
  if (![maxNoncesPerBuyerPerWindow, nonceWindowMs].every(n => uint(n) && n > 0)) throw new Error('positive nonce limits required');
  if (!['maxStartsPerHour', 'maxStartsPerBuyerPerHour'].every(key => uint(contextStartLimits?.[key]) && contextStartLimits[key] > 0)) throw new TypeError('positive context start limits required');
  const parent = dirname(path);
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      directory.uid !== process.getuid?.() || realpathSync(parent) !== parent) throw new Error('transport store needs a private, real host-local directory');
  try {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.()) throw new Error('transport store file must be private and regular');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000');
  db.exec(`CREATE TABLE IF NOT EXISTS peer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peer_jobs (job TEXT PRIMARY KEY, context TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peer_effects (effect TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, response TEXT);
    CREATE TABLE IF NOT EXISTS peer_effect_jobs (effect TEXT PRIMARY KEY, job TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kit_context_reservations (effect TEXT PRIMARY KEY, nonce TEXT NOT NULL UNIQUE, accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)));
    CREATE TABLE IF NOT EXISTS kit_purchase_profiles (job TEXT PRIMARY KEY, profile TEXT NOT NULL, kept_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS kit_slot_retirements (job TEXT PRIMARY KEY, job_retired INTEGER NOT NULL DEFAULT 0, context_retired INTEGER NOT NULL DEFAULT 0, owner TEXT);
    CREATE TABLE IF NOT EXISTS kit_job_owners (job TEXT PRIMARY KEY, buyer TEXT NOT NULL, seller TEXT NOT NULL, pin TEXT NOT NULL, agreement_hash TEXT, closed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS kit_context_admissions (jobId TEXT PRIMARY KEY, buyer TEXT NOT NULL, admittedAt INTEGER, state TEXT NOT NULL, rev INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS kit_context_admissions_starts ON kit_context_admissions(admittedAt, buyer);
    CREATE TABLE IF NOT EXISTS kit_job_holds (jobId TEXT PRIMARY KEY, buyer TEXT NOT NULL, seller TEXT NOT NULL,
      listing_pin TEXT NOT NULL, context INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS kit_reservations (key TEXT PRIMARY KEY, buyer TEXT NOT NULL, jobId TEXT NOT NULL REFERENCES kit_job_holds(jobId),
      operationId TEXT NOT NULL, route TEXT NOT NULL, allocationId TEXT, class TEXT NOT NULL, requestHash TEXT NOT NULL,
      at INTEGER NOT NULL, state TEXT NOT NULL, code TEXT, rev INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS kit_reservations_buyer_at ON kit_reservations(buyer, at);
    CREATE INDEX IF NOT EXISTS kit_reservations_job ON kit_reservations(jobId);
    CREATE TABLE IF NOT EXISTS kit_payment_transactions (tx TEXT PRIMARY KEY, jobId TEXT NOT NULL, operationId TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kit_terminal_closures (jobId TEXT PRIMARY KEY, state TEXT NOT NULL, observedAt INTEGER NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('cleanup', 'effect-path', 'session-observer')));
    CREATE INDEX IF NOT EXISTS peer_effect_jobs_job ON peer_effect_jobs(job);`);
  try { dropEmptyObsoleteTables(db, STORE_VERSION); } catch (error) { db.close(); throw error; }
  // rollback: always roll back (a read-only run, such as contextHoldState). A result that is a Promise or thenable rolls back too.
  function immediate(fn, rollback = false) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (typeof result?.then === 'function') { void Promise.resolve(result).then(undefined, () => {}); throw new TypeError('a store transaction is synchronous'); }
      db.exec(rollback ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // The terminal observer: every DACS-5 state any reader sees goes through `contextSessionState`. A terminal name waits in
  // `pending` until `closeTerminalWithin`, the one writer of a closure, records it with the capacity's cleanup: in the commit of the work
  // that saw it, otherwise in a transaction of its own after that work rolled back, before the answer or error leaves.
  const pending = new Map();
  const closureOf = db.prepare('SELECT state FROM kit_terminal_closures WHERE jobId = ?');
  let cleanupWithin = null;
  function requireBoundCleanup() {
    if (cleanupWithin === null) throw new TypeError('the terminal cleanup is not bound: construct the purchase capacity on this store first');
  }
  function closeTerminalWithin(jobId, state, source) {
    requireBoundCleanup();
    if (!db.inTransaction) throw new TypeError('a terminal closure is recorded in the store transaction');
    if (!TERMINAL_CONTEXT_STATES.has(state) || !CLOSURE_SOURCES.has(source)) throw new TypeError('a closure needs a terminal state and a known source');
    const at = now();
    if (!uint(at)) fail('peer_clock_invalid', 503);
    db.prepare('INSERT OR IGNORE INTO kit_terminal_closures VALUES (?, ?, ?, ?)').run(jobId, state, at, source);
    const cleaned = cleanupWithin(jobId);
    if (typeof cleaned?.then === 'function') { void Promise.resolve(cleaned).then(undefined, () => {}); throw new TypeError('the terminal cleanup is synchronous'); }
  }
  const flushWithin = () => { for (const [jobId, { state, source }] of pending) closeTerminalWithin(jobId, state, source); };
  function flushPending() {
    if (pending.size === 0) return;
    immediate(flushWithin);
    pending.clear();
  }
  // A failed flush keeps its own error, with the refused work's error as its cause, and the observations stay pending.
  function flushAfterRefusal(refusal) {
    try { flushPending(); } catch (failure) {
      if (failure !== refusal && failure instanceof Error && failure.cause === undefined) failure.cause = refusal;
      throw failure;
    }
  }
  function transaction(fn, rollback = false) {
    if (!db.inTransaction) flushPending();
    let result;
    try { result = immediate(() => { const value = fn(); if (!rollback) flushWithin(); return value; }, rollback); } catch (error) { flushAfterRefusal(error); throw error; }
    if (rollback) flushPending(); else pending.clear();
    return result;
  }
  // Only a synchronous string or an explicit null answers; a throw, a Promise or any other value refuses unavailable 503 with its cause.
  const readPort = jobId => readSellerSessionState(readSessionState, jobId);
  // The job's closure answers first, then an observation still pending, then the port. Outside a transaction a terminal name is written
  // before this returns; inside one it is written by the transaction. `cleanup` re-runs the release for a job that already has a closure.
  function contextSessionState({ jobId }, source = 'session-observer') {
    requireBoundCleanup();
    const closed = closureOf.get(jobId)?.state ?? null;
    const state = closed ?? pending.get(jobId)?.state ?? readPort(jobId);
    if (TERMINAL_CONTEXT_STATES.has(state) && !pending.has(jobId) && (closed === null || source === 'cleanup') && kitOperationAdmitted()) pending.set(jobId, { state, source });
    if (!db.inTransaction) flushPending();
    return state;
  }
  function terminalSession(jobId) {
    assertKitOperationAdmitted('terminalSession');
    if (db.inTransaction) throw new TypeError('terminalSession runs outside a store transaction');
    const state = contextSessionState({ jobId }, 'effect-path');
    return TERMINAL_CONTEXT_STATES.has(state) ? Object.freeze({ terminal: true, state }) : NOT_TERMINAL;
  }
  function flushTerminalObservations() {
    requireBoundCleanup();
    if (db.inTransaction) throw new TypeError('terminal observations are flushed outside a store transaction');
    flushPending();
  }
  function bindTerminalCleanup(cleanup) {
    if (typeof cleanup !== 'function' || cleanupWithin !== null) throw new TypeError('the terminal cleanup is a function, bound once');
    cleanupWithin = cleanup;
  }
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const readSessionStateWithin = jobId => contextSessionState({ jobId });
  // Reclamation keeps a row whose session cannot be read; the observer's own failures still propagate.
  const terminalForReclamation = jobId => {
    try { return TERMINAL_CONTEXT_STATES.has(readSessionStateWithin(jobId)); } catch (error) {
      if (error?.code !== 'session_admission_unavailable' || error.status !== 503) throw error;
      return false;
    }
  };
  // A purchase's TP-1 tuple, as the canonical text kept for its job.
  const purchaseProfileText = (profile) => {
    if (!isTp1WireProfile(profile)) fail('tp1_purchase_profile_mismatch', 500);
    return canonicalize(profile);
  };
  const keptProfileText = (jobId) => get('SELECT profile FROM kit_purchase_profiles WHERE job = ?', jobId)?.profile ?? null;
  // Detached tuples and their later job binding share the admitting transaction.
  const keepPurchaseProfileWithin = (jobId, profile, time = now()) => {
    if (!db.inTransaction) throw new TypeError('tuple write needs the store transaction');
    requireJobId(jobId); if (!uint(time)) fail('peer_clock_invalid', 503);
    const text = purchaseProfileText(profile), kept = keptProfileText(jobId);
    if (kept !== null && kept !== text) fail('tp1_purchase_profile_mismatch', 500);
    if (kept === null) run('INSERT INTO kit_purchase_profiles VALUES (?, ?, ?)', jobId, text, time);
  };
  const keepJobWithin = (p, profile, time) => {
    claimJobWithin(p);
    keepPurchaseProfileWithin(p.jobId, profile, time);
    run('INSERT INTO peer_jobs VALUES (?, ?)', p.jobId, canonicalize(requestIdentity(p)));
  };
  // The job an accounted reservation charges, with its owner and whether it holds a context record. It is never an
  // Agreement (no job row or tuple) and never leaves while a reservation references it.
  const holdJobWithin = (p, context) => { claimJobWithin(p); run(`INSERT INTO kit_job_holds VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(jobId) DO UPDATE SET context = MAX(context, excluded.context)`, p.jobId, p.buyer, p.seller, canonicalize(p.listingPin), context ? 1 : 0); };
  function claimJobWithin(p) {
    run(`INSERT INTO kit_job_owners(job, buyer, seller, pin, agreement_hash) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(job) DO UPDATE SET agreement_hash = COALESCE(kit_job_owners.agreement_hash, excluded.agreement_hash)`,
    p.jobId, p.buyer, p.seller, canonicalize(p.listingPin), p.path === CONTEXT ? null : p.agreementHash);
  }
  // An accounting row stops counting once its request has expired (a request admitted at `at` is expired by
  // `at` plus one transport lifetime, and the wire journal refuses its nonce key again). It is kept while it is `reserving`
  // (a crash left it) and, while its job is not retired, while it is the first settled row of its job and route, the witness of
  // that route's one effect (`accountedSlotWithin`, `terminalStartWithin`). Once the job is retired every expired row except
  // a `reserving` one stops counting, witnesses included; the rows stay in the table and keep answering those two reads.
  // The one parameter is the cutoff time.
  const reservationRetentionMs = Math.max(MAX_TRANSPORT_LIFETIME_MS, nonceWindowMs);
  const RETIRABLE_RESERVATION = `at <= ? AND state <> 'reserving' AND (state = 'refused'
    OR EXISTS (SELECT 1 FROM kit_slot_retirements r WHERE r.job = kit_reservations.jobId AND r.job_retired = 1)
    OR EXISTS (SELECT 1 FROM kit_reservations w
    WHERE w.jobId = kit_reservations.jobId AND w.route = kit_reservations.route AND w.state IN ('new', 'recover', 'completed') AND w.key < kit_reservations.key))`;
  const admissions = () => Boolean(get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'peer_context_admissions'"));
  if (admissions()) db.exec(CONTEXT_EFFECT_INDEX);
  // RESERVATION_LEDGER's sources in this store: the context admission table exists only once a first admission commits.
  const activeK1 = (job, slot) => `SELECT 1 FROM kit_context_admissions k WHERE k.jobId = ${job} AND k.state <> 'aborted' AND NOT EXISTS (SELECT 1 FROM kit_slot_retirements r WHERE r.job = k.jobId AND r.${slot}_retired = 1)`;
  const activeHold = job => `SELECT 1 FROM kit_job_holds h WHERE h.jobId = ${job} AND NOT EXISTS (SELECT 1 FROM kit_slot_retirements r WHERE r.job = h.jobId AND r.job_retired = 1)`;
  const ledgerSources = (kind) => {
    const hasAdmissions = kind !== 'buyerUnits' && admissions();
    return RESERVATION_LEDGER[kind].filter(sql => hasAdmissions || !sql.includes('peer_context_admissions')).map(sql =>
    kind !== 'owners' && sql.includes('peer_context_admissions') ? `${sql} WHERE NOT EXISTS (SELECT 1 FROM kit_slot_retirements r WHERE r.job = peer_context_admissions.job AND r.${kind === 'jobs' ? 'job' : 'context'}_retired = 1)` :
    kind !== 'owners' && sql.includes('kit_job_holds') ? `${sql}${sql.includes('WHERE') ? ' AND' : ' WHERE'} EXISTS (${activeHold('kit_job_holds.jobId')})` :
    kind !== 'owners' && sql.includes('kit_context_admissions') ? `${sql} WHERE EXISTS (${activeK1('kit_context_admissions.jobId', kind === 'jobs' ? 'job' : 'context')})` : sql);
  };
  const ledgerJobs = (kind) => `SELECT job FROM (${ledgerSources(kind).join(' UNION ')})`;
  // Whether the wire's own record holds the request's operation under this request's binding: any attempt, whatever its
  // state. An operation is only {seller, jobId, path}, so a request with another context scope or Agreement hash shares
  // it and the wire would refuse it later; only the binding tells it from a retry. No reader, no view or another binding is no record.
  const wireHoldsWithin = (p) => {
    const view = wireOperationView({ seller: p.seller, jobId: p.jobId, path: p.path });
    return ![undefined, null, 'none'].includes(view?.state) && view.binding === wireOperationBinding(p);
  };
  // The accounting rows that still count at `time`; the purchase capacity's `used` is this count too.
  const retainedReservationCount = (time) => get(`SELECT COUNT(*) AS n FROM kit_reservations WHERE NOT (${RETIRABLE_RESERVATION})`, time - reservationRetentionMs).n;
  // Every read runs in the caller's transaction.
  const reservationLedger = Object.freeze({
    recordCountWithin: (time) => retainedReservationCount(time),
    buyerUnitsWithin: (buyer, time) => get(`SELECT COUNT(*) AS n FROM (${ledgerSources('buyerUnits').join(' UNION ALL ')})
      WHERE buyer = ? AND at > ?`, buyer, time - nonceWindowMs).n,
    jobHeldWithin: (jobId) => Boolean(get(`SELECT job FROM (${retainedJobs()}) WHERE job = ?`, jobId)),
    jobCountWithin: () => get(`SELECT COUNT(*) AS n FROM (${retainedJobs()})`).n,
    contextHeldWithin: (jobId) => Boolean(get(`${ledgerJobs('contextRecords')} WHERE job = ?`, jobId)),
    contextCountWithin: () => get(`SELECT COUNT(*) AS n FROM (${ledgerJobs('contextRecords')})`).n,
    // A job belongs to the buyer, seller and Listing pin of every record that holds it. A job row also fixes the
    // Agreement, which a context step does not carry (its agreementHash slot is the context scope hash).
    jobConflictWithin: (p) => {
      const binding = get(`SELECT (SELECT agreement_hash FROM kit_job_owners WHERE job = ?) AS agreement_hash,
        (SELECT context FROM peer_jobs WHERE job = ?) AS context`, p.jobId, p.jobId);
      if (p.path !== CONTEXT && binding.agreement_hash !== null && binding.agreement_hash !== p.agreementHash) return true;
      if (p.path !== CONTEXT && binding.context !== null && binding.context !== canonicalize(requestIdentity(p))) return true;
      return db.prepare(`SELECT buyer, seller, pin FROM (${ledgerSources('owners').join(' UNION ALL ')}) WHERE job = ?`)
        .all(p.jobId).some(row => row.buyer !== p.buyer || row.seller !== p.seller || canonicalize(JSON.parse(row.pin)) !== canonicalize(p.listingPin));
    },
    jobRetiredWithin: jobId => Boolean(get('SELECT 1 FROM kit_slot_retirements WHERE job = ? AND job_retired = 1', jobId)),
    jobClosedWithin: p => get('SELECT closed FROM kit_job_owners WHERE job = ?', p.jobId)?.closed === 1 && !wireHoldsWithin(p),
    // Only a job row establishes a purchase; its kept tuple, or null for an old-path job kept without one.
    purchaseWithin: (jobId) => get('SELECT k.profile FROM peer_jobs j LEFT JOIN kit_purchase_profiles k ON k.job = j.job WHERE j.job = ?', jobId),
    // The refusals of the old reserve path that read journal state, shared so both paths apply each one.
    sessionTerminalWithin: (jobId) => TERMINAL_CONTEXT_STATES.has(readSessionStateWithin(jobId)),
    // A terminal session refuses a fresh proposal or context start; an operation already reserved is a retry, which
    // still reaches the wire for its recover or completed answer. A retry is a row of the operation the wire answered
    // (new, recover, completed) or, still `reserving`, one the wire's own record holds (an attempt, not a nonce key
    // alone: after a crash before publication, or a refusal whose write failed, the wire would answer `new`), and in
    // both cases the wire's record carries this request's binding (another context scope or Agreement hash is a fresh start).
    // With no reader, no record or another binding, the request is refused.
    terminalStartWithin: (p, operationId) => (p.path === PROPOSAL || p.path === CONTEXT) && TERMINAL_CONTEXT_STATES.has(readSessionStateWithin(p.jobId)) &&
      !(get("SELECT 1 FROM kit_reservations WHERE jobId = ? AND operationId = ? AND state IN ('new', 'recover', 'completed', 'reserving')", p.jobId, operationId) && wireHoldsWithin(p)),
    retiredReplayWithin: (p, operationId) => {
      if (READ_ROUTES.has(p.path) || !get('SELECT 1 FROM kit_slot_retirements WHERE job = ? AND job_retired = 1', p.jobId)) return false;
      // A completed row is durable proof; checked.reserve still verifies the request's binding before replay.
      if (get("SELECT 1 FROM kit_reservations WHERE jobId = ? AND operationId = ? AND state = 'completed'", p.jobId, operationId)) return true;
      const view = wireOperationView({ seller: p.seller, jobId: p.jobId, path: p.path });
      return view?.state === 'completed' && view.binding === wireOperationBinding(p);
    },
    // A mutating route has one effect per job. An accounted reservation holds it unless the wire definitely refused it
    // (a definite refusal is no effect); a `reserving` row left by a crash holds it too.
    accountedSlotWithin: (jobId, route) => !READ_ROUTES.has(route) &&
      Boolean(get("SELECT 1 FROM kit_reservations WHERE jobId = ? AND route = ? AND state <> 'refused'", jobId, route)),
    // Only the first proposal, the first payment and a context start make a job; any other route needs its job row.
    unknownJobWithin: (p) => ![PROPOSAL, PAYMENT, CONTEXT].includes(p.path) && !get('SELECT 1 FROM peer_jobs WHERE job = ?', p.jobId),
  });
  // An effect with no job binding conservatively prevents job-row reclamation.
  transaction(() => {
    if (admissions()) run('INSERT OR IGNORE INTO peer_effect_jobs SELECT effect, job FROM peer_context_admissions');
  });
  // `skip` holds jobs another plan already frees, so one job never counts as leaving twice.
  function reclaimableJobs(needed, jobId, time, skip = new Set()) {
    // Unmapped legacy effects fence all reclamation; empty bindings need no terminal evidence.
    if (!needed || get('SELECT 1 FROM peer_effects e WHERE NOT EXISTS (SELECT 1 FROM peer_effect_jobs m WHERE m.effect = e.effect) LIMIT 1')) return [];
    const hasAdmissions = admissions();
    const jobs = db.prepare(`SELECT j.job FROM peer_jobs j WHERE
      ${jobId === undefined ? '' : 'j.job = ? AND '}
      NOT EXISTS (SELECT 1 FROM peer_effect_jobs m WHERE m.job = j.job)
      AND NOT EXISTS (${activeHold('j.job')})
      AND NOT EXISTS (${activeK1('j.job', 'job')})
      ${hasAdmissions ? 'AND NOT EXISTS (SELECT 1 FROM peer_context_admissions a WHERE a.job = j.job)' : ''}
      LIMIT ?`).all(...(jobId === undefined ? [] : [jobId]), needed).map(row => row.job);
    if (time === undefined || jobs.length === needed) return jobs;
    // Complete terminal jobs, admission-only ones included, retire only after the context retention window.
    // Active accounted holds and admission holders fence reclamation.
    for (const { job } of db.prepare(`SELECT job FROM (SELECT job FROM peer_jobs${hasAdmissions ? ' UNION SELECT job FROM peer_context_admissions' : ''}) j
      WHERE (EXISTS (SELECT 1 FROM peer_jobs p WHERE p.job = j.job)
        OR NOT EXISTS (SELECT 1 FROM kit_slot_retirements r WHERE r.job = j.job AND r.job_retired = 1))
      AND NOT EXISTS (${activeHold('j.job')})
      AND NOT EXISTS (${activeK1('j.job', 'job')}) AND NOT EXISTS (
      SELECT 1 FROM peer_effect_jobs m LEFT JOIN peer_effects e ON e.effect = m.effect WHERE m.job = j.job
      AND (e.state IS NULL OR e.state <> 'complete'))
      ${hasAdmissions ? 'AND NOT EXISTS (SELECT 1 FROM peer_context_admissions a WHERE a.job = j.job AND a.admitted_at > ?)' : ''}`)
      .iterate(...(hasAdmissions ? [time - CHALLENGE_RATE_WINDOW_MS] : []))) {
      if (!jobs.includes(job) && !skip.has(job) && terminalForReclamation(job)) jobs.push(job);
      if (jobs.length === needed) break;
    }
    return jobs;
  }
  // Plan reclamation with reads only. Full-capacity refusals must execute no
  // mutations, even ones a transaction could roll back. Only terminal context
  // slots may retire; unresolved effects and live requests fence retirement.
  function reclaimableContexts(time, count) {
    if (!admissions()) return [];
    count ??= reservationLedger.contextCountWithin();
    const needed = Math.max(0, count - maxContextRecords + 1);
    if (!needed) return [];
    const rows = [];
    for (const row of db.prepare(`SELECT a.job, a.effect FROM peer_context_admissions a
      JOIN peer_effects e ON e.effect = a.effect WHERE a.admitted_at <= ? AND e.state = 'complete'
      AND NOT EXISTS (SELECT 1 FROM kit_slot_retirements r WHERE r.job = a.job AND r.context_retired = 1)
      AND NOT EXISTS (${activeHold('a.job')})
      AND NOT EXISTS (${activeK1('a.job', 'context')})`).iterate(time - CHALLENGE_RATE_WINDOW_MS)) {
      if (terminalForReclamation(row.job)) rows.push(row);
      if (rows.length === needed) break;
    }
    return rows;
  }
  function retireSlotsWithin(time, jobId, plan) {
    if (!db.inTransaction) throw new TypeError('slot retirement needs the store transaction');
    if (!uint(time)) fail('peer_clock_invalid', 503); if (jobId !== undefined) requireJobId(jobId);
    for (const { job } of db.prepare(`SELECT job FROM (SELECT jobId AS job FROM kit_context_admissions WHERE state = 'settled' AND admittedAt <= ? UNION SELECT jobId AS job FROM kit_job_holds) candidates
      WHERE NOT EXISTS (SELECT 1 FROM kit_slot_retirements r WHERE r.job = candidates.job AND r.job_retired = 1 AND r.context_retired = 1)${jobId === undefined ? '' : ' AND job = ?'}`).all(time - CHALLENGE_RATE_WINDOW_MS, ...(jobId === undefined ? [] : [jobId]))) {
      if (get("SELECT 1 FROM kit_context_admissions WHERE jobId = ? AND (state NOT IN ('settled', 'aborted') OR admittedAt > ?)", job, time - CHALLENGE_RATE_WINDOW_MS) ||
          get("SELECT 1 FROM kit_reservations WHERE jobId = ? AND (state NOT IN ('new', 'recover', 'completed', 'refused') OR at > ? OR (route = ? AND at > ?))", job, time - nonceWindowMs, CONTEXT, time - CHALLENGE_RATE_WINDOW_MS) ||
          db.prepare("SELECT route, MIN(state = 'refused') AS refused FROM kit_reservations WHERE jobId = ? GROUP BY route HAVING MAX(state = 'completed') = 0").all(job).some(({ route, refused }) => {
            if (READ_ROUTES.has(route)) return false;
            try {
              const state = wireOperationView({ jobId: job, seller: get('SELECT seller FROM kit_job_holds WHERE jobId = ?', job).seller, path: route })?.state;
              return !(state === 'completed' || (state === 'ended' && retainsUnfinishedWork({ jobId: job, path: route }) === false) || (state === 'none' && refused));
            } catch { return true; }
          }) ||
          get("SELECT 1 FROM peer_effect_jobs m LEFT JOIN peer_effects e ON e.effect = m.effect WHERE m.job = ? AND e.state IS NULL", job) ||
          get("SELECT 1 FROM peer_effects e LEFT JOIN peer_effect_jobs m ON m.effect = e.effect WHERE m.effect IS NULL OR (m.job = ? AND e.state <> 'complete')", job) ||
          (admissions() && get('SELECT 1 FROM peer_context_admissions WHERE job = ? AND admitted_at > ?', job, time - CHALLENGE_RATE_WINDOW_MS)) || !terminalForReclamation(job)) continue;
      run('INSERT INTO kit_slot_retirements(job, job_retired, context_retired) VALUES (?, 1, 1) ON CONFLICT(job) DO UPDATE SET job_retired = 1, context_retired = 1', job);
      run('UPDATE kit_job_owners SET closed = 1 WHERE job = ?', job);
      if (!get('SELECT 1 FROM peer_jobs WHERE job = ?', job)) run('DELETE FROM kit_purchase_profiles WHERE job = ?', job);
    }
    const contexts = (plan?.contexts ?? reclaimableContexts(time, plan?.capacity ? undefined : Number.MAX_SAFE_INTEGER)).filter(row => jobId === undefined || row.job === jobId);
    const freed = new Set(contexts.filter(row => reservationLedger.jobHeldWithin(row.job) && !get('SELECT 1 FROM peer_jobs WHERE job = ?', row.job)).map(row => row.job));
    const jobs = (plan?.jobs ?? reclaimableJobs(plan?.capacity ? Math.max(0, reservationLedger.jobCountWithin() - freed.size - maxJobs + 1) : Number.MAX_SAFE_INTEGER, jobId, time, freed)).filter(job => jobId === undefined || job === jobId);
    for (const job of new Set([...jobs, ...contexts.map(row => row.job)])) {
      const owner = get(`SELECT buyer, seller, pin FROM (${ledgerSources('owners').join(' UNION ALL ')}) WHERE job = ? LIMIT 1`, job);
      const contextRetired = Number(Boolean(contexts.some(row => row.job === job) ||
        (jobs.includes(job) && admissions() && get('SELECT 1 FROM peer_context_admissions WHERE job = ?', job))));
      const closed = Number(Boolean(contextRetired || get('SELECT 1 FROM peer_effect_jobs WHERE job = ?', job)));
      if (owner) run(`INSERT INTO kit_slot_retirements(job, job_retired, context_retired, owner) VALUES (?, ?, ?, ?)
        ON CONFLICT(job) DO UPDATE SET job_retired = MAX(job_retired, excluded.job_retired), context_retired = MAX(context_retired, excluded.context_retired), owner = excluded.owner`,
      job, closed, contextRetired, canonicalize({ buyer: owner.buyer, seller: owner.seller, listingPin: JSON.parse(owner.pin) }));
    }
    for (const job of jobs) {
      run('DELETE FROM kit_purchase_profiles WHERE job = ?', job); run('DELETE FROM peer_jobs WHERE job = ?', job);
    }
  }
  function reserveAdmissionWithin(input, time) {
    const p = { ...input, path: CONTEXT };
    if (reservationLedger.jobConflictWithin(p)) fail('peer_job_conflict', 409);
    retireSlotsWithin(time);
    if (reservationLedger.jobRetiredWithin(p.jobId) || get('SELECT closed FROM kit_job_owners WHERE job = ?', p.jobId)?.closed === 1 ||
        get('SELECT 1 FROM kit_context_admissions WHERE jobId = ?', p.jobId) ||
        (admissions() && get('SELECT 1 FROM peer_context_admissions WHERE job = ?', p.jobId))) fail('context_job_closed', 409);
    if (!reservationLedger.jobHeldWithin(p.jobId) && reservationLedger.jobCountWithin() >= maxJobs) fail('peer_job_capacity', 503);
    if (!reservationLedger.contextHeldWithin(p.jobId) && reservationLedger.contextCountWithin() >= maxContextRecords) fail('peer_context_capacity', 503);
    claimJobWithin(p);
  }
  function deleteEffect(effect) {
    for (const table of ['peer_effects', 'kit_context_reservations', 'peer_effect_jobs', ...(admissions() ? ['peer_context_admissions'] : [])]) run(`DELETE FROM ${table} WHERE effect = ?`, effect);
  }
  const startsIn = (table, column, since, buyer) => get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} > ?${buyer === undefined ? '' : ' AND buyer = ?'}`, since, ...(buyer === undefined ? [] : [buyer])).n;
  const starts = (since, buyer) => (admissions() ? startsIn('peer_context_admissions', 'admitted_at', since, buyer) : 0) + startsIn('kit_context_admissions', 'admittedAt', since, buyer);
  // The ledger's unpaid-start counts over the union of this journal's admission records and the K1 admission rows (SA-5):
  // a start counts once admitted, compensated ones included; an intent that never admitted has no `admittedAt`.
  function admissionCounts({ jobId } = {}) {
    const time = now(), since = time - CHALLENGE_RATE_WINDOW_MS, contextCount = reservationLedger.contextCountWithin();
    return { contextRecords: jobId !== undefined && reservationLedger.contextHeldWithin(jobId) ? 0 : contextCount,
      starts: starts(since), buyerStarts: buyer => starts(since, buyer) };
  }
  const { maxStartsPerHour, maxStartsPerBuyerPerHour } = contextStartLimits;
  const ledger = createSellerChallengeLedger({ db, transaction, now, generation, ready, stopped, sessionState: contextSessionState, admissionCounts: input => {
      retireSlotsWithin(now(), undefined, { capacity: true, jobs: [] }); return admissionCounts(input);
    },
    limits: { maxChallenges, maxContextRecords, maxPerHour: maxStartsPerHour, maxPerBuyerPerHour: maxStartsPerBuyerPerHour, maxStartsPerHour, maxStartsPerBuyerPerHour } });
  // Keep acceptance proof with the retained context answer, even if its terminal challenge is reclaimed.
  function acceptWithin(owner, nonce, record) {
    const accepted = ledger.acceptWithin(owner, nonce, record);
    if (accepted) run('UPDATE kit_context_reservations SET accepted = 1 WHERE nonce = ?', nonce);
    return accepted;
  }
  // The routes hold a whole request; the ledger keeps its job and buyer. Without a delegation to check
  // (this store's own callers), the final liveness check is a no-op: the context route passes its own.
  const challenges = Object.freeze({ ...ledger, acceptWithin,
    issue: (request, challengeScopeHash, authorization = NO_DELEGATION) => ledger.issue({ jobId: request?.jobId, buyer: request?.buyer }, challengeScopeHash, authorization),
    issueForOperator: request => ledger.issueForOperator({ jobId: request?.jobId, buyer: request?.buyer }),
    accept: (owner, nonce, record) => transaction(() => acceptWithin(owner, nonce, record)) });
  // Profiles retain purchase identity without holding an execution slot.
  const retainedJobs = () => ledgerJobs('jobs');
  const reservationAccounting = createReservationAccounting({
    store: { get, run, transaction, ledger: reservationLedger, holdJobWithin, keepJobWithin, retireSlotsWithin },
    now, limits: { maxRecords, maxJobs, maxContextRecords, maxNoncesPerBuyerPerWindow },
    contextRecords: contextRecords ?? (() => admissionCounts().contextRecords),
  });
  const store = {
    reservationAccounting,
    challenges,
    // A marker alone is insufficient while any transport source still holds the job.
    jobSlotReleased: jobId => reservationLedger.jobRetiredWithin(jobId) && !reservationLedger.jobHeldWithin(jobId),
    // Only the holder of the seller state lock calls this at startup, after `challenges.closeLostValidations()`
    // and before serving or policy-hold reconciliation: every context step still `pending` belongs to a dead owner.
    // One the ledger never accepted ran nothing: it ends as a definite refusal and its hold is later found absent.
    // One it accepted (or an earlier version's, which has no marker) becomes `uncertain`.
    // The marker outlives the challenge row's reclamation.
    recoverLostContextReservations() {
      return transaction(() => {
        if (!admissions()) return;
        for (const row of db.prepare(`SELECT e.effect, e.owner, v.accepted FROM peer_effects e JOIN peer_context_admissions a ON a.effect = e.effect
          LEFT JOIN kit_context_reservations v ON v.effect = e.effect WHERE e.state = 'pending'`).all()) {
          if (row.accepted !== 0) run("UPDATE peer_effects SET state = 'uncertain' WHERE effect = ? AND owner = ? AND state = 'pending'", row.effect, row.owner);
          else deleteEffect(row.effect);
        }
      });
    },
    bind({ seller, listingPin }) {
      const config = canonicalize({ storeVersion: STORE_VERSION, seller, listingPin });
      transaction(() => {
        const stored = get('SELECT value FROM peer_meta WHERE key = ?', 'config');
        if (stored && stored.value !== config) throw new Error('transport store belongs to another seller, Listing or schema');
        if (!stored) run('INSERT INTO peer_meta VALUES (?, ?)', 'config', config);
      });
    },
    // The TP-1 tuple kept for a job, or null when none was kept.
    purchaseProfile(jobId) {
      requireJobId(jobId);
      const text = keptProfileText(jobId);
      return text === null ? null : JSON.parse(text);
    },
    // Whether the job's seller context session has ended; it reads only the session reader (through the observation adapter), so it holds whichever tables accounted the job. An
    // unreadable source is never "not terminal": a throw, a thenable or a non-null non-string answer is refused
    // `session_admission_unavailable` 503 with its cause, and only an explicit null reads as no session.
    sessionTerminal(jobId) {
      requireJobId(jobId);
      return TERMINAL_CONTEXT_STATES.has(contextSessionState({ jobId }));
    },
    /** Classify a policy hold's exact job/effect at startup without changing the journal.
     * Returns absent, complete, pending, uncertain or retry; throws on invalid or inconsistent bindings. */
    contextHoldState({ jobId, effect }) {
      requireJobId(jobId);
      if (!isHash(effect)) fail('peer_context_reconciliation_conflict', 503);
      return transaction(() => {
        const saved = get('SELECT state, status, response FROM peer_effects WHERE effect = ?', effect);
        const mapped = get('SELECT job FROM peer_effect_jobs WHERE effect = ?', effect);
        const admission = admissions() ? get('SELECT effect FROM peer_context_admissions WHERE job = ?', jobId) : null;
        const other = admissions() ? get('SELECT job FROM peer_context_admissions WHERE effect = ? AND job <> ? LIMIT 1', effect, jobId) : null;
        if (!saved && !mapped && admission?.effect !== effect && !other) return 'absent';
        if (!saved || mapped?.job !== jobId || admission?.effect !== effect || other
            || !['complete', 'pending', 'uncertain', 'retry'].includes(saved.state)
            || (saved.state === 'complete' && (!uint(saved.status) || saved.status < 200 || saved.status >= 500
              || typeof saved.response !== 'string' || Buffer.byteLength(saved.response) > DACS_SELLER_HTTP_LIMITS.maxResponseBodyBytes))) {
          fail('peer_context_reconciliation_conflict', 503);
        }
        return saved.state;
      }, true);
    },
    close: () => db.close(),
  };
  storeInternals.set(store, Object.freeze({ db, transaction, challenges, admissionCounts, keepPurchaseProfileWithin, reserveAdmissionWithin, retireSlotsWithin, retainedReservationCount, limits: Object.freeze({ maxContextRecords, maxStartsPerHour, maxStartsPerBuyerPerHour }),
    terminalSession, sessionState: contextSessionState, bindTerminalCleanup, flushTerminalObservations }));
  return store;
}

/**
 * The one SQLite owner behind a store that `createSellerTransportStore` returned: `{ db, transaction, challenges, admissionCounts, keepPurchaseProfileWithin, reserveAdmissionWithin, retireSlotsWithin, retainedReservationCount, limits,
 * terminalSession, sessionState, bindTerminalCleanup, flushTerminalObservations }`, where `limits` are the context-record and unpaid-start
 * limits the ledger enforces at issue. `sessionState({ jobId }, source)` is the one observation adapter: it answers a job's closure, else the
 * port's synchronous DACS-5 name or null, and keeps a terminal name (the closure and the capacity's release) with the work that saw it or,
 * when that work is refused, fails or rolls back, in a transaction of its own before the answer leaves. `terminalSession(jobId)` is the
 * synchronous check for purchase work: `{ terminal, state }`, with the closure committed before a terminal answer; it throws a
 * TypeError inside a transaction and the persistence error when a closure cannot be written. `flushTerminalObservations()` commits the
 * observations a failed write left pending. `bindTerminalCleanup(fn)` is called once, by the purchase capacity; the adapter throws a
 * TypeError until then.
 * For the seller's own admission modules, which run their reads and writes in that store's immediate transactions; it is not a
 * public export and grants no wire or lease authority. Throws a TypeError for anything else.
 */
export function sellerStoreInternals(store) {
  const internals = typeof store === 'object' && store !== null ? storeInternals.get(store) : undefined;
  if (internals === undefined) throw new TypeError('sellerStoreInternals needs a store from createSellerTransportStore');
  return internals;
}
