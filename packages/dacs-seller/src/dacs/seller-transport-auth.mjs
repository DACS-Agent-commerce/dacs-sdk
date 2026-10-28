// Private, loopback-only adapter profile, not a DACS wire protocol. The pinned
// SDK paymentEvidenceHandshake delegates peer authentication to its host and
// only supports x402 evidence anchoring. This DEM transport uses its canonical
// hashing primitives, with a separate buyer/seller Ed25519 signing callback.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { constants, closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import DatabaseSync from 'better-sqlite3';
import { admitRawJson, RawJsonAdmissionError, canonicalize, createFixedPriceAgreementSigningPlan, isCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { decodeSignature, isSmallOrderPublicKey } from './demos-claims.mjs';
import { assertSellerSessionLifetime } from '../public/portal/seller-session-limits.mjs';

export const SELLER_TRANSPORT_HEADER = 'x-dacs-seller-peer';
export const SELLER_TRANSPORT_MAX_RESPONSE = 512 * 1024;
const MAX_TRANSPORT_LIFETIME_MS = 60_000;
const MAX_TRANSPORT_HEADER_CHARS = 4096;
const DEFAULT_TRANSPORT_LIFETIME_MS = 30_000;
const DOMAIN = 'dacs-chatgpt-plugin:loopback-seller-peer:v1:';
const DELEGATION_DOMAIN = 'dacs-chatgpt-plugin:seller-session-delegation:v1:';
const HASH = /^[0-9a-f]{64}$/;
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{22,86}$/;
const isHash = value => typeof value === 'string' && HASH.test(value);
const isClaim = value => typeof value === 'string' && CLAIM.test(value);
const isNonce = value => typeof value === 'string' && NONCE.test(value);
const PROPOSAL = '/dacs/v1/agreements/proposals';
const STATE = '/dacs/v1/agreements/state';
const PAYMENT = '/dacs/v1/payments';
// The Vet and Agreement-context step (seller context route) precedes the
// Agreement, so its envelope carries the hash of the exact context scope in
// the agreementHash slot. It never binds the job's Agreement in peer_jobs.
// Presentations use a seller-issued, durable, single-use challenge bound to
// the context scope without its bundle hash. Exact retained-effect retries
// read their old answer; they never admit another presentation.
export const SELLER_CONTEXT_PATH = '/dacs/v1/agreements/context';
const CONTEXT = SELLER_CONTEXT_PATH;
export const SELLER_CONTEXT_CHALLENGE_PATH = CONTEXT + '/challenge';
// The plugin's Agreement-context scope without its own account and operation ids.
export const SELLER_CONTEXT_SCOPE_KEYS = Object.freeze(['source', 'wallet', 'jobId', 'buyer', 'buyerBundleHash', 'seller', 'listingPin', 'rail', 'payee', 'price', 'generatedAt']);
export const sellerContextChallengeScope = (value) => { requireJobId(value?.jobId); const { buyerBundleHash, ...scope } = value; return scope; };
export const sellerContextScopeHash = (scope) => { requireJobId(scope?.jobId); return sha256Hex(canonicalize(scope)); };
const READ_ROUTES = new Set([STATE, '/dacs/v1/bundles/buyer-copy']);
const exact = (a, b) => canonicalize(a) === canonicalize(b);
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, expected) => record(v) && Object.keys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k));
const uint = (v) => Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);
const clone = (v) => JSON.parse(JSON.stringify(v));
const fail = (code, status = 401) => { throw new SellerTransportError(code, status); };
function requireJobId(jobId) {
  if (!isCanonicalJobId(jobId)) fail('peer_job_invalid', 409);
}

/** Transport refusal with a stable code, HTTP status and optional original cause. */
export class SellerTransportError extends Error {
  constructor(code, status = 401, options) { super(code, options); this.code = code; this.status = status; }
}

function pinValid(pin) {
  return keys(pin, ['listingId', 'version', 'contentHash']) &&
    typeof pin.listingId === 'string' && pin.listingId.length > 0 && pin.listingId.length <= 256 &&
    uint(pin.version) && pin.version > 0 && typeof pin.contentHash === 'string' && isHash(pin.contentHash);
}

function payloadValid(p, kind) {
  const fields = ['version', 'kind', 'method', 'path', 'bodyHash', 'jobId', 'buyer', 'seller', 'listingPin', 'agreementHash', 'nonce', 'expiresAt'];
  if (kind === 'response') fields.push('requestHash', 'status');
  return ['request', 'response'].includes(kind) && keys(p, fields) && p.version === '1' && p.kind === kind && p.method === 'POST' &&
    typeof p.path === 'string' && /^\/dacs\/v1\/[a-z/-]+$/.test(p.path) && p.path.length <= 160 &&
    isHash(p.bodyHash) && isCanonicalJobId(p.jobId) && isClaim(p.buyer) && isClaim(p.seller) && p.buyer !== p.seller &&
    pinValid(p.listingPin) && isHash(p.agreementHash) && isNonce(p.nonce) &&
    Buffer.from(p.nonce, 'base64url').toString('base64url') === p.nonce && uint(p.expiresAt) &&
    (kind !== 'response' || (isHash(p.requestHash) && uint(p.status) && p.status >= 200 && p.status <= 599));
}

/** Return the exact envelope signing bytes; throw on malformed payloads. */
export function sellerTransportSigningBytes(payload) {
  if (!payloadValid(payload, payload?.kind)) fail('peer_envelope_invalid');
  return Buffer.from(`${DOMAIN}${canonicalize(payload)}`, 'utf8');
}

function signatureBytes(signature) {
  if (signature instanceof Uint8Array && signature.byteLength === 64) return Buffer.from(signature);
  if (typeof signature === 'string' && /^[A-Za-z0-9_-]{86}$/.test(signature)) {
    const bytes = Buffer.from(signature, 'base64url');
    if (bytes.length === 64 && bytes.toString('base64url') === signature) return bytes;
  }
  if (typeof signature === 'string' && /^(?:0x)?[0-9a-fA-F]{128}$/.test(signature)) return Buffer.from(signature.replace(/^0x/, ''), 'hex');
  fail('peer_signature_invalid');
}

async function signedHeader(payload, signer, delegation) {
  const signature = signatureBytes(await signer.sign(sellerTransportSigningBytes(payload))).toString('base64url');
  return Buffer.from(canonicalize({ payload, signature, ...(delegation ? { delegation } : {}) })).toString('base64url');
}

// A delegation is read only when the seller is configured for delegated
// sessions; otherwise the envelope keeps the exact pre-delegation shape.
function verifiedHeader(header, kind, principal, { requireDelegation = false, onDelegation } = {}) {
  if (typeof header !== 'string' || header.length > MAX_TRANSPORT_HEADER_CHARS || !/^[A-Za-z0-9_-]+$/.test(header)) fail('peer_envelope_invalid');
  const bytes = Buffer.from(header, 'base64url');
  if (bytes.toString('base64url') !== header) fail('peer_envelope_invalid');
  let envelope;
  try { envelope = admitRawJson(bytes); } catch (cause) {
    const error = new SellerTransportError('peer_envelope_invalid', 401, { cause });
    if (cause instanceof RawJsonAdmissionError) { error.admissionCode = cause.code; error.admissionStage = cause.stage; }
    throw error;
  }
  const delegated = kind === 'request' && requireDelegation && Object.hasOwn(envelope ?? {}, 'delegation');
  if (!keys(envelope, ['payload', 'signature', ...(delegated ? ['delegation'] : [])]) || !payloadValid(envelope.payload, kind)) fail('peer_envelope_invalid');
  if (requireDelegation && !delegated) fail('peer_delegation_required');
  const p = envelope.payload;
  const actor = kind === 'request' ? p.buyer : p.seller;
  if (principal && actor !== principal) fail('peer_signer_wrong');
  const delegation = delegated ? verifySellerSessionDelegation(envelope.delegation, { buyer: p.buyer }) : null;
  const publicKey = publicKeyFor(delegation?.sessionPublicKey ?? actor.slice('did:demos:agent:'.length), 'peer_signature_invalid');
  if (!verify(null, sellerTransportSigningBytes(p), publicKey, signatureBytes(envelope.signature))) fail('peer_signature_invalid');
  if (delegation) onDelegation?.(p, envelope.delegation);
  return p;
}

// The Ed25519 key of a 64-digit hex public key; a small-order key is refused with `code`.
function publicKeyFor(raw, code) {
  if (isSmallOrderPublicKey(Buffer.from(raw, 'hex'))) fail(code);
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'hex')]), format: 'der', type: 'spki' });
}

/** Return delegation signing bytes; throw on invalid scope or lifetime. */
export function sellerSessionDelegationSigningBytes(payload) {
  if (!keys(payload, ['version', 'kind', 'buyer', 'sessionPublicKey', 'seller', 'listingPin', 'jobId', 'notBefore', 'expiresAt']) ||
      payload.version !== '1' || payload.kind !== 'seller-session-delegation' || typeof payload.buyer !== 'string' || typeof payload.seller !== 'string' || !isClaim(payload.buyer) || !isClaim(payload.seller) ||
      payload.buyer === payload.seller || typeof payload.sessionPublicKey !== 'string' || !isHash(payload.sessionPublicKey) || !pinValid(payload.listingPin) || !isCanonicalJobId(payload.jobId) ||
      !uint(payload.notBefore) || !uint(payload.expiresAt) || payload.expiresAt <= payload.notBefore) fail('peer_delegation_invalid');
  try { assertSellerSessionLifetime(payload.expiresAt-payload.notBefore); } catch { fail('peer_delegation_invalid'); }
  return Buffer.from(`${DELEGATION_DOMAIN}${canonicalize(payload)}`, 'utf8');
}

// The delegation signature comes from the buyer's wallet, so it is decoded
// exactly as identity presentations are (decodeSignature), including the
// repeated "0x0x" prefix some wallets return.
function delegationSignatureBytes(signature) {
  try { return decodeSignature(signature); } catch { fail('peer_delegation_signature_invalid'); }
}

/** Return canonical base64url wallet signature bytes; throw on malformed input. */
export function normalizeSellerSessionDelegationSignature(signature) {
  return delegationSignatureBytes(signature).toString('base64url');
}

// time: also require notBefore <= time < expiresAt. allowExpired keeps only
// the notBefore check; it is for readback of already journaled effects (see
// docs/SELLER-SESSION-DELEGATION.md), never for starting a new seller effect.
/** Authenticate delegation scope and optional time bounds; return its payload or throw. */
export function verifySellerSessionDelegation(delegation, { buyer, seller, listingPin, jobId, time, deadline, allowExpired = false } = {}) {
  if (!keys(delegation, ['payload', 'signature'])) fail('peer_delegation_invalid');
  const p = delegation.payload, bytes = sellerSessionDelegationSigningBytes(p);
  if (!verify(null, bytes, publicKeyFor(p.buyer.slice('did:demos:agent:'.length), 'peer_delegation_signature_invalid'), delegationSignatureBytes(delegation.signature))) fail('peer_delegation_signature_invalid');
  if ((buyer !== undefined && p.buyer !== buyer) || (seller !== undefined && p.seller !== seller) ||
      (listingPin !== undefined && !exact(p.listingPin, listingPin)) || (jobId !== undefined && p.jobId !== jobId)) fail('peer_delegation_mismatch', 409);
  if (time !== undefined && (!uint(time) || p.notBefore > time || (!allowExpired && p.expiresAt <= time))) fail('peer_delegation_expired', 408);
  if (deadline !== undefined && (!uint(deadline) || p.expiresAt > deadline)) fail('peer_delegation_deadline', 409);
  return clone(p);
}

function checkSigner(signer) {
  if (!isClaim(signer?.claim) || typeof signer.sign !== 'function') throw new Error('a separate Demos Ed25519 signing callback is required');
}

function requestIdentity(p) {
  requireJobId(p?.jobId);
  return { jobId: p.jobId, buyer: p.buyer, seller: p.seller, listingPin: p.listingPin, agreementHash: p.agreementHash };
}

const effectIdentity = (p) => sha256Hex(canonicalize({ ...requestIdentity(p), method: p.method, path: p.path, bodyHash: p.bodyHash }));
// The journal's effect key for an authenticated request (the context route ties its write reservation to it).
export const sellerTransportEffect = effectIdentity;

function validateBody(p, body) {
  if (!record(body)) fail('peer_body_invalid', 409);
  if (p.path === SELLER_CONTEXT_CHALLENGE_PATH) {
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
const CONTEXT_ADMISSIONS = `CREATE TABLE IF NOT EXISTS peer_context_admissions (job TEXT PRIMARY KEY, buyer TEXT NOT NULL, seller TEXT NOT NULL,
  listing_pin TEXT NOT NULL, scope_hash TEXT NOT NULL, effect TEXT NOT NULL, admitted_at INTEGER NOT NULL)`;

// Trusted seller state retains terminal ownership; unknown state retains challenges.
const TERMINAL_CONTEXT_STATES = new Set(['finalised', 'vet-failed', 'negotiate-failed', 'commit-failed', 'settle-failed', 'aborted-by-self', 'aborted-by-other', 'failed-substrate']);
const CHALLENGE_RATE_WINDOW_MS = 3600000;
const NO_EFFECT_KEY = 'no-effect'; // Outside the effect-hash namespace; preserves definite nonce answers.
export function createSellerTransportStore({ path, maxRecords = 10000, maxJobs = maxRecords, maxChallenges = maxRecords, maxContextRecords = maxRecords, contextSessionState = () => null, maxNoncesPerBuyerPerWindow = 120, nonceWindowMs = 60000, now = () => Date.now() }) {
  if (typeof path !== 'string' || !isAbsolute(path) || !uint(maxRecords) || maxRecords === 0) throw new Error('a persistent absolute path and positive store capacity are required');
  if (!uint(maxJobs) || maxJobs === 0) throw new Error('positive job capacity required');
  if (!uint(maxChallenges) || maxChallenges === 0 || typeof contextSessionState !== 'function') throw new Error('positive challenge capacity and seller session-state reader required');
  if (!uint(maxContextRecords) || maxContextRecords === 0) throw new Error('positive context capacity required');
  if (![maxNoncesPerBuyerPerWindow, nonceWindowMs].every(n => uint(n) && n > 0)) throw new Error('positive nonce limits required');
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
    CREATE TABLE IF NOT EXISTS peer_slots (slot TEXT PRIMARY KEY, effect TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peer_transactions (tx TEXT PRIMARY KEY, job TEXT NOT NULL, effect TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peer_nonces (nonce TEXT PRIMARY KEY, request_hash TEXT NOT NULL, effect TEXT NOT NULL, status INTEGER, response TEXT);
    CREATE TABLE IF NOT EXISTS peer_nonce_retention (nonce TEXT PRIMARY KEY, buyer TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS peer_context_challenges (nonce TEXT PRIMARY KEY, job TEXT NOT NULL, buyer TEXT NOT NULL, scope TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, attempted INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS peer_effect_jobs_job ON peer_effect_jobs(job);
    CREATE INDEX IF NOT EXISTS peer_transactions_job ON peer_transactions(job);
    CREATE INDEX IF NOT EXISTS peer_nonces_effect ON peer_nonces(effect);`);
  // rollback: always roll back (classify's read-only run of reserve).
  function transaction(fn, rollback = false) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec(rollback ? 'ROLLBACK' : 'COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  // Legacy nonce rows did not carry expiry. Keep them for one full maximum
  // request lifetime from upgrade before considering safe reclamation.
  transaction(() => {
    const time = now();
    for (const { nonce } of db.prepare('SELECT nonce FROM peer_nonces WHERE nonce NOT IN (SELECT nonce FROM peer_nonce_retention)').all()) {
      run('INSERT INTO peer_nonce_retention VALUES (?, ?, ?, ?)', nonce, nonce.slice(0, nonce.lastIndexOf(':')), time, time + 60000);
    }
  });
  const admissions = () => Boolean(get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'peer_context_admissions'"));
  // Legacy slots identify mutating effects. Legacy reads have no job identity;
  // any such unmapped effect conservatively prevents job-row reclamation.
  transaction(() => {
    run("INSERT OR IGNORE INTO peer_effect_jobs SELECT effect, substr(slot, 1, instr(slot, ':') - 1) FROM peer_slots WHERE instr(slot, ':') > 0");
    if (admissions()) run('INSERT OR IGNORE INTO peer_effect_jobs SELECT effect, job FROM peer_context_admissions');
  });
  function reclaimableJobs(needed, jobId, time) {
    // Unmapped legacy effects fence all reclamation; empty bindings need no terminal evidence.
    if (!needed || get('SELECT 1 FROM peer_effects e WHERE NOT EXISTS (SELECT 1 FROM peer_effect_jobs m WHERE m.effect = e.effect) LIMIT 1')) return [];
    const jobs = db.prepare(`SELECT j.job FROM peer_jobs j WHERE
      ${jobId === undefined ? '' : 'j.job = ? AND '}
      NOT EXISTS (SELECT 1 FROM peer_effect_jobs m WHERE m.job = j.job)
      AND NOT EXISTS (SELECT 1 FROM peer_transactions t WHERE t.job = j.job)
      AND NOT EXISTS (SELECT 1 FROM peer_slots s WHERE s.slot >= j.job || ':' AND s.slot < j.job || ';')
      ${admissions() ? 'AND NOT EXISTS (SELECT 1 FROM peer_context_admissions a WHERE a.job = j.job)' : ''}
      LIMIT ?`).all(...(jobId === undefined ? [] : [jobId]), needed).map(row => row.job);
    if (time === undefined || jobs.length === needed) return jobs;
    // Complete terminal jobs retire only after every nonce and context retention window.
    for (const { job } of db.prepare(`SELECT job FROM peer_jobs j WHERE NOT EXISTS (
      SELECT 1 FROM peer_effect_jobs m LEFT JOIN peer_effects e ON e.effect = m.effect WHERE m.job = j.job
      AND (e.state IS NULL OR e.state <> 'complete' OR EXISTS (SELECT 1 FROM peer_nonces n
        LEFT JOIN peer_nonce_retention r ON r.nonce = n.nonce WHERE n.effect = m.effect
        AND (r.nonce IS NULL OR r.expires_at > ? OR r.created_at > ?))))
      ${admissions() ? 'AND NOT EXISTS (SELECT 1 FROM peer_context_admissions a WHERE a.job = j.job AND a.admitted_at > ?)' : ''}`)
      .iterate(time, time - nonceWindowMs, ...(admissions() ? [time - CHALLENGE_RATE_WINDOW_MS] : []))) {
      if (!jobs.includes(job) && TERMINAL_CONTEXT_STATES.has(contextSessionState({ jobId: job }))) jobs.push(job);
      if (jobs.length === needed) break;
    }
    return jobs;
  }
  // Plan reclamation with reads only. Full-capacity refusals must execute no
  // mutations, even ones a transaction could roll back. Only terminal context
  // effects may leave retention; unresolved effects and live requests fence it.
  function reclaimableContexts(time) {
    if (!admissions()) return [];
    const needed = Math.max(0, get('SELECT COUNT(*) AS n FROM peer_context_admissions').n - maxContextRecords + 1);
    if (!needed) return [];
    const rows = [];
    for (const row of db.prepare(`SELECT a.job, a.effect FROM peer_context_admissions a
      JOIN peer_effects e ON e.effect = a.effect WHERE a.admitted_at <= ? AND e.state = 'complete'
      AND NOT EXISTS (SELECT 1 FROM peer_nonces n LEFT JOIN peer_nonce_retention r ON r.nonce = n.nonce
        WHERE n.effect = a.effect AND (r.nonce IS NULL OR r.expires_at > ? OR r.created_at > ?))`).iterate(time - CHALLENGE_RATE_WINDOW_MS, time, time - nonceWindowMs)) {
      if (TERMINAL_CONTEXT_STATES.has(contextSessionState({ jobId: row.job }))) rows.push(row);
      if (rows.length === needed) break;
    }
    return rows;
  }
  function reclaimContexts(rows) {
    for (const row of rows) {
      run('DELETE FROM peer_nonce_retention WHERE nonce IN (SELECT nonce FROM peer_nonces WHERE effect = ?)', row.effect);
      run('DELETE FROM peer_nonces WHERE effect = ?', row.effect);
      deleteEffect(row.effect);
    }
  }
  function deleteEffect(effect) {
    for (const table of ['peer_effects', 'peer_slots', 'peer_transactions', 'peer_effect_jobs', ...(admissions() ? ['peer_context_admissions'] : [])]) run(`DELETE FROM ${table} WHERE effect = ?`, effect);
  }
  function contextPresentationProblem(request,body) {
        const nonce = body.buyerIdentityBundle?.sessionNonce;
        if (typeof nonce !== 'string' || !HASH.test(nonce)) return 'context_challenge_mismatch';
        const row = get('SELECT * FROM peer_context_challenges WHERE nonce = ?', nonce);
        if (!row) return 'context_challenge_mismatch';
        if (row.attempted) return 'context_challenge_consumed';
        run('UPDATE peer_context_challenges SET attempted = 1 WHERE nonce = ?', row.nonce);
        try {
          if (row.job !== request.jobId || row.buyer !== request.buyer || row.scope !== sellerContextScopeHash(sellerContextChallengeScope(body.scope))) return 'context_challenge_mismatch';
        } catch { return 'context_challenge_mismatch'; }
        if (row.expires_at <= now()) return 'context_challenge_expired';
        return null;
  }
  return {
    issueContextChallenge(request, scope, { maxPerBuyer = 5, maxGlobal = 12, admit } = {}) {
      requireJobId(request?.jobId);
      requireJobId(scope?.jobId);
      if (request.jobId !== scope.jobId) fail('peer_job_mismatch', 409);
      return transaction(() => {
        const time = now(), hash = sellerContextScopeHash(scope);
        if (!uint(time)) fail('peer_clock_invalid', 503);
        if (![maxPerBuyer, maxGlobal].every(n => uint(n) && n > 0)) fail('context_challenge_limits_invalid', 503);
        if (TERMINAL_CONTEXT_STATES.has(contextSessionState({ jobId: request.jobId }))) fail('context_session_terminal', 409);
        const prior = get('SELECT * FROM peer_context_challenges WHERE job = ? AND buyer = ? AND scope = ? AND attempted = 0 AND expires_at > ?', request.jobId, request.buyer, hash, time);
        if (prior) return { sessionNonce: prior.nonce, expiresAt: prior.expires_at };
        if (get('SELECT COUNT(*) AS n FROM peer_context_challenges WHERE issued_at > ?', time - CHALLENGE_RATE_WINDOW_MS).n >= maxGlobal) fail('context_challenge_limit', 429);
        if (get('SELECT COUNT(*) AS n FROM peer_context_challenges WHERE buyer = ? AND issued_at > ?', request.buyer, time - CHALLENGE_RATE_WINDOW_MS).n >= maxPerBuyer) fail('buyer_context_challenge_limit', 429);
        // Keep every issued/consumed row through session termination (SN-4),
        // and through its rate window. Inspect first: a refused issuance must
        // execute no mutation, including cleanup that would later roll back.
        const needed = Math.max(0, get('SELECT COUNT(*) AS n FROM peer_context_challenges').n - maxChallenges + 1);
        const reclaimable = [];
        if (needed) for (const row of db.prepare('SELECT nonce, job, buyer FROM peer_context_challenges WHERE expires_at <= ? AND issued_at <= ?').iterate(time, time - CHALLENGE_RATE_WINDOW_MS)) {
          if (TERMINAL_CONTEXT_STATES.has(contextSessionState({ jobId: row.job }))) reclaimable.push(row);
          if (reclaimable.length === needed) break;
        }
        if (reclaimable.length < needed) fail('context_challenge_capacity', 503);
        const retired = reclaimableContexts(time);
        if ((admissions() ? get('SELECT COUNT(*) AS n FROM peer_context_admissions').n : 0) - retired.length >= maxContextRecords) fail('peer_context_capacity', 503);
        if (typeof admit !== 'function') fail('peer_context_unadmitted', 503);
        admit({ starts: (since, buyer) => admissions() ? get(`SELECT COUNT(*) AS n FROM peer_context_admissions WHERE admitted_at > ?${buyer === undefined ? '' : ' AND buyer = ?'}`, since, ...(buyer === undefined ? [] : [buyer])).n : 0 });
        for (const row of reclaimable) run('DELETE FROM peer_context_challenges WHERE nonce = ?', row.nonce);
        const sessionNonce = randomBytes(32).toString('hex'), expiresAt = time + 60000;
        run('INSERT INTO peer_context_challenges VALUES (?, ?, ?, ?, ?, ?, 0)', sessionNonce, request.jobId, request.buyer, hash, time, expiresAt);
        return { sessionNonce, expiresAt };
      });
    },
    // Called after transport authentication, before admission or presentation validation.
    // Consumption commits even when proof verification subsequently refuses.
    attemptContextPresentation(request, body) {
      requireJobId(request?.jobId);
      requireJobId(body?.scope?.jobId);
      const problem=transaction(()=>contextPresentationProblem(request,body));
      if (problem) fail(problem, 409);
    },
    bind({ seller, listingPin }) {
      const config = canonicalize({ storeVersion: '1', seller, listingPin });
      transaction(() => {
        const stored = get('SELECT value FROM peer_meta WHERE key = ?', 'config');
        if (stored && stored.value !== config) throw new Error('transport store belongs to another seller, Listing or schema');
        if (!stored) run('INSERT INTO peer_meta VALUES (?, ?)', 'config', config);
      });
    },
    // journaledOnly (an expired session delegation): read routes, replays of
    // an earlier nonce and the exact effect already journaled for this job
    // (cached answer, or uncertain -> read-only reconciliation) are allowed.
    // Anything that would start a new effect is refused before any insert.
    // admit({starts}) is required when a context request starts new work and
    // runs only then, inside this transaction: starts(since, buyer?) counts
    // admission records newer than `since`. It returns the admission time or
    // throws a refusal, which rolls back every row of this request.
    reserve(p, body, { journaledOnly = false, admit = null, dryRun = false, contextDecision = false, verdict = null } = {}) {
      requireJobId(p?.jobId);
      if (p.path === CONTEXT) {
        requireJobId(body?.scope?.jobId);
        if (body.scope.jobId !== p.jobId) fail('peer_job_mismatch', 409);
      }
      // The admission table is created inside this transaction; it exists only after a commit.
      const result=transaction(() => {
        const creates = p.path === CONTEXT && !admissions();
        const requestHash = sha256Hex(canonicalize(p));
        const nonce = `${p.buyer}:${p.nonce}`;
        const previous = get('SELECT * FROM peer_nonces WHERE nonce = ?', nonce);
        if (previous) {
          if (previous.request_hash !== requestHash) fail('peer_nonce_conflict', 409);
          // A definite earlier no-effect answer belongs to its own nonce,
          // even if a fresh attempt of the same command later succeeds.
          if (previous.response !== null && (previous.status < 500 || previous.effect === NO_EFFECT_KEY)) return { disposition: 'cached', status: previous.status, text: previous.response };
          const effect = get('SELECT * FROM peer_effects WHERE effect = ?', previous.effect);
          if (effect?.state === 'complete') return { disposition: 'cached', status: effect.status, text: effect.response };
          if (effect) return { disposition: 'uncertain', effectKey: effect.effect, owner: effect.owner };
          if (previous.response !== null) return { disposition: 'cached', status: previous.status, text: previous.response };
          return { disposition: 'uncertain' };
        }
        const context = canonicalize(requestIdentity(p));
        const job = get('SELECT context FROM peer_jobs WHERE job = ?', p.jobId);
        const contextStep = p.path === CONTEXT;
        // The context step is checked against the job's parties and pin only:
        // its agreementHash slot is the context scope hash, not the Agreement.
        const parties = (value) => { const { agreementHash, ...rest } = value; return canonicalize(rest); };
        if (job && (contextStep ? parties(JSON.parse(job.context)) !== parties(requestIdentity(p)) : job.context !== context)) fail('peer_job_conflict', 409);
        // Before the Agreement the job belongs to the buyer of its admission record.
        const admitted = admissions() ? get('SELECT buyer, seller, listing_pin FROM peer_context_admissions WHERE job = ?', p.jobId) : null;
        if (admitted && (admitted.buyer !== p.buyer || admitted.seller !== p.seller || admitted.listing_pin !== canonicalize(p.listingPin))) fail('peer_job_conflict', 409);
        const effectKey = effectIdentity(p);
        if (journaledOnly && !READ_ROUTES.has(p.path) && !get('SELECT effect FROM peer_effects WHERE effect = ?', effectKey)) fail('peer_delegation_expired', 408);
        // The SDK buyer coordinator reconciles before publishing a proposal.
        // An unadmitted job has no authenticated state to disclose or reserve.
        const unknownState = !job && p.path === STATE;
        if (!job && p.path !== PROPOSAL && !contextStep && !unknownState) fail('peer_unknown_job', 404);
        const slot = `${p.jobId}:${p.path}`;
        const occupied = READ_ROUTES.has(p.path) ? null : get('SELECT effect FROM peer_slots WHERE slot = ?', slot);
        if (occupied && occupied.effect !== effectKey) fail('peer_operation_conflict', 409);
        const existing = get('SELECT * FROM peer_effects WHERE effect = ?', effectKey);
        // Fresh nonces for retained effects are read-only, including uncertainty.
        // The exception is an effect the agent answered as not final yet
        // (finish with retry): it runs again under the same effect and slot, so
        // the agent's own retained work decides, and another body still conflicts.
        // Running it again is new work (it may sign and send): under an expired
        // delegation (journaledOnly) it answers its last journaled answer instead.
        let retained = unknownState
          ? { disposition: 'cached', status: 200, text: '{"proposal":null,"contribution":null}' }
          : existing?.state === 'retry' && journaledOnly ? { disposition: 'cached', status: existing.status, text: existing.response } : null;
        const retry = existing?.state === 'retry' && !contextStep;
        if (existing && !retry && !retained) retained = existing.state === 'complete' ? { disposition: 'cached', status: existing.status, text: existing.response } : { disposition: 'uncertain', effectKey, owner: existing.owner };
        const time = now();
        if (!uint(time)) fail('peer_clock_invalid', 503);
        const retired = [];
        if (!retained && p.path === PROPOSAL && TERMINAL_CONTEXT_STATES.has(contextSessionState({ jobId: p.jobId }))) fail('context_session_terminal', 409);
        if (contextStep && !retained) {
          if (TERMINAL_CONTEXT_STATES.has(contextSessionState({ jobId: p.jobId }))) fail('context_session_terminal', 409);
          retired.push(...reclaimableContexts(time));
          if ((admissions() ? get('SELECT COUNT(*) AS n FROM peer_context_admissions').n : 0) - retired.length >= maxContextRecords) { if(contextDecision)contextPresentationProblem(p,body);return {contextRefusal:'peer_context_capacity',status:503}; }
        }
        // Only expired completed/no-effect nonces are reclaimable. Unknown or
        // pending effects remain fenced, even after request expiry.
        const reclaimable = `SELECT n.nonce FROM peer_nonces n LEFT JOIN peer_nonce_retention r ON r.nonce = n.nonce
          LEFT JOIN peer_effects e ON e.effect = n.effect WHERE r.expires_at <= ?
          AND (e.state = 'complete' OR (e.state = 'retry' AND n.response IS NOT NULL) OR (e.effect IS NULL AND n.response IS NOT NULL))`;
        const expired = get('SELECT COUNT(*) AS n FROM peer_nonces WHERE nonce IN (' + reclaimable + ')', time).n;
        if (get('SELECT COUNT(*) AS n FROM peer_nonces').n - expired >= maxRecords ||
            get(`SELECT COUNT(*) AS n FROM peer_nonce_retention WHERE expires_at > ? OR created_at > ?
              OR nonce IN (SELECT nonce FROM peer_nonces WHERE nonce NOT IN (${reclaimable}))`, time, time - nonceWindowMs, time).n >= maxRecords) fail('peer_store_capacity', 503);
        if (get('SELECT COUNT(*) AS n FROM peer_nonce_retention WHERE buyer = ? AND created_at > ?', p.buyer, time - nonceWindowMs).n >= maxNoncesPerBuyerPerWindow) fail('peer_buyer_nonce_limit', 429);
        const neededJobs = !job && !contextStep && !retained ? Math.max(0, get('SELECT COUNT(*) AS n FROM peer_jobs').n - maxJobs + 1) : 0;
        const retiredJobs = reclaimableJobs(neededJobs, undefined, time);
        if (retiredJobs.length < neededJobs) fail('peer_job_capacity', 503);
        let admittedAt=null;
        if(contextStep&&!existing) {
          let problem=contextDecision?contextPresentationProblem(p,body):null;
          problem??=verdict;
          if(!problem) {
            const starts=(since,buyer)=>admissions()?get(`SELECT COUNT(*) AS n FROM peer_context_admissions WHERE admitted_at > ?${buyer===undefined?'':' AND buyer = ?'}`,since,...(buyer===undefined?[]:[buyer])).n:0;
            try { admittedAt=typeof admit==='function'?admit({starts}):null; }
            catch(error) { if(!contextDecision)throw error;problem=error.code; }
            if(!problem&&!uint(admittedAt))fail('peer_context_unadmitted',503);
          }
          if(problem) {
            const text=JSON.stringify({error:problem});
            run('INSERT INTO peer_nonces VALUES (?, ?, ?, ?, ?)',nonce,requestHash,NO_EFFECT_KEY,409,text);
            run('INSERT INTO peer_nonce_retention VALUES (?, ?, ?, ?)',nonce,p.buyer,time,p.expiresAt);
            return {contextRefusal:problem};
          }
        }
        if (p.path === PAYMENT && !retained) {
          const tx = body.txHash.replace(/^0x/, '').toLowerCase();
          const claimed = get('SELECT job, effect FROM peer_transactions WHERE tx = ?', tx);
          // A transport claim is not SB-2 authority. Competing jobs must reach
          // authenticated payment intake so it can suspend the collision group.
          if (!dryRun && !claimed) run('INSERT INTO peer_transactions VALUES (?, ?, ?)', tx, p.jobId, effectKey);
        }
        // Dry admission checks execute no INSERT, UPDATE, DELETE or DDL.
        if (dryRun) return retained ?? { disposition: 'perform' };
        reclaimContexts(retired);
        for (const jobId of retiredJobs) {
          reclaimContexts(db.prepare('SELECT effect FROM peer_effect_jobs WHERE job = ?').all(jobId));
          run('DELETE FROM peer_jobs WHERE job = ?', jobId);
        }
        run('DELETE FROM peer_nonces WHERE nonce IN (' + reclaimable + ')', time);
        // Keep the rate counters for the full rate window, even when the nonce
        // itself has expired and was pruned.
        run('DELETE FROM peer_nonce_retention WHERE expires_at <= ? AND created_at <= ? AND nonce NOT IN (SELECT nonce FROM peer_nonces)', time, time - nonceWindowMs);
        if (creates) db.exec(CONTEXT_ADMISSIONS);
        if (!job && !contextStep && !retained) run('INSERT INTO peer_jobs VALUES (?, ?)', p.jobId, context);
        run('INSERT INTO peer_nonces VALUES (?, ?, ?, NULL, NULL)', nonce, requestHash, effectKey);
        run('INSERT INTO peer_nonce_retention VALUES (?, ?, ?, ?)', nonce, p.buyer, time, p.expiresAt);
        if (retained) {
          if (retained.disposition === 'cached') run('UPDATE peer_nonces SET status = ?, response = ? WHERE nonce = ?', retained.status, retained.text, nonce);
          return retained;
        }
        if (contextStep) run('INSERT INTO peer_context_admissions VALUES (?, ?, ?, ?, ?, ?, ?)', p.jobId, p.buyer, p.seller, canonicalize(p.listingPin), p.agreementHash, effectKey, admittedAt);
        const owner = randomBytes(24).toString('hex');
        if (retry) {
          run('UPDATE peer_effects SET owner = ?, state = ?, status = NULL, response = NULL WHERE effect = ?', owner, 'pending', effectKey);
          return { disposition: 'perform', effectKey, owner, readOnly: false, retried: true };
        }
        run('INSERT INTO peer_effects VALUES (?, ?, ?, NULL, NULL)', effectKey, owner, 'pending');
        run('INSERT INTO peer_effect_jobs VALUES (?, ?)', effectKey, p.jobId);
        if (!READ_ROUTES.has(p.path) && !occupied) run('INSERT INTO peer_slots VALUES (?, ?)', slot, effectKey);
        return { disposition: 'perform', effectKey, owner, readOnly: READ_ROUTES.has(p.path) };
      }, dryRun);
      if(result.contextRefusal)fail(result.contextRefusal,result.status??409);
      return result;
    },
    // Read-only reserve: 'start' for new work, 'known' for journaled answers;
    // conflicts throw reserve's refusal. No mutations run; the transaction rolls back.
    classify(p, body, { journaledOnly = false, admit = () => 0 } = {}) {
      return this.reserve(p, body, { journaledOnly, admit, dryRun: true }).disposition === 'perform' ? 'start' : 'known';
    },
    // The context step's pre-Agreement admission record for a job, or null:
    // {jobId, buyer, seller, listingPin, scopeHash, effect, admittedAt}.
    contextAdmission(jobId) {
      requireJobId(jobId);
      const row = admissions() ? get('SELECT * FROM peer_context_admissions WHERE job = ?', jobId) : null;
      return row ? { jobId: row.job, buyer: row.buyer, seller: row.seller, listingPin: JSON.parse(row.listing_pin), scopeHash: row.scope_hash, effect: row.effect, admittedAt: row.admitted_at } : null;
    },
    // The completed context step's journaled {status, text}, or null.
    contextAnswer(jobId) {
      requireJobId(jobId);
      const row = admissions() ? get("SELECT e.status, e.response FROM peer_context_admissions a JOIN peer_effects e ON e.effect = a.effect WHERE a.job = ? AND e.state = 'complete'", jobId) : null;
      return row ? { status: row.status, text: row.response } : null;
    },
    // noEffect: a definite answer that started nothing (its rows go). retry:
    // an answer the agent marks as not final yet (a 200 answer, or a refusal
    // of a claim whose work the agent retains); its effect stays bound to its
    // slot and runs again on a fresh nonce (reserve). Otherwise complete.
    finish(reservation, status, text, { noEffect = false, retry = false } = {}) {
      if (!uint(status) || status < 200 || status > 599) fail('peer_response_invalid', 503);
      if (Buffer.byteLength(text) > SELLER_TRANSPORT_MAX_RESPONSE) fail('peer_response_too_large', 503);
      if (retry && (noEffect || reservation.readOnly || !uint(status))) fail('peer_store_conflict', 503);
      transaction(() => {
        const current = get('SELECT * FROM peer_effects WHERE effect = ?', reservation.effectKey);
        if (!current || current.owner !== reservation.owner || current.state !== 'pending') fail('peer_store_conflict', 503);
        run('UPDATE peer_nonces SET status = ?, response = ?, effect = ? WHERE effect = ? AND response IS NULL', status, text, noEffect || reservation.readOnly ? NO_EFFECT_KEY : reservation.effectKey, reservation.effectKey);
        if (noEffect || reservation.readOnly) {
          const identity = get('SELECT job FROM peer_effect_jobs WHERE effect = ?', reservation.effectKey);
          deleteEffect(reservation.effectKey);
          // Release a provisional binding only when no other effect still refers to it.
          if (identity && reclaimableJobs(1, identity.job).length) run('DELETE FROM peer_jobs WHERE job = ?', identity.job);
        } else {
          run('UPDATE peer_effects SET state = ?, status = ?, response = ? WHERE effect = ?', retry ? 'retry' : status >= 500 ? 'uncertain' : 'complete', status, text, reservation.effectKey);
        }
      });
    },
    // The host may resolve only the SAME retained operation, after its seller
    // reducer has authenticated durable context and fresh native readback. No
    // reservation, slot or transaction is released; no expired intent retries.
    // A pending effect may be performed by a live run: only readback of a
    // finished effect (200) can complete it; retry and noEffect need `uncertain`.
    // retry (payments and proposals): the agent resumed its durable operation;
    // the effect goes back to `retry`, so the next claim runs it again.
    // noEffect (payments only): the claim ended before the work checkpoint with
    // a definite answer that kept nothing; its effect, slot and transaction go.
    reconcile(reservation, request, status, text, { retry = false, noEffect = false } = {}) {
      requireJobId(request?.jobId);
      if (status !== 200 || Buffer.byteLength(text) > SELLER_TRANSPORT_MAX_RESPONSE) fail('peer_reconciliation_invalid', 503);
      if ((noEffect && request.path !== PAYMENT) || (retry && request.path !== PAYMENT && request.path !== '/dacs/v1/agreements/proposals')) fail('peer_reconciliation_invalid', 503);
      if (retry && noEffect) fail('peer_reconciliation_invalid', 503);
      transaction(() => {
        const current = get('SELECT * FROM peer_effects WHERE effect = ?', reservation.effectKey);
        if (reservation.disposition !== 'uncertain' || reservation.effectKey !== effectIdentity(request) ||
            !current || current.owner !== reservation.owner || !(current.state === 'uncertain' || (current.state === 'pending' && !retry && !noEffect)) ||
            // The context step is bound by its admission record, the other steps by the job's Agreement row.
            (request.path === CONTEXT ? !admissions() || get('SELECT effect FROM peer_context_admissions WHERE job = ? AND buyer = ?', request.jobId, request.buyer)?.effect !== reservation.effectKey
              : get('SELECT context FROM peer_jobs WHERE job = ?', request.jobId)?.context !== canonicalize(requestIdentity(request)))) fail('peer_reconciliation_conflict', 503);
        run('UPDATE peer_nonces SET status = ?, response = ?, effect = ? WHERE effect = ? AND (response IS NULL OR status >= 500)', status, text, noEffect || READ_ROUTES.has(request.path) ? NO_EFFECT_KEY : reservation.effectKey, reservation.effectKey);
        if (noEffect || READ_ROUTES.has(request.path)) {
          const identity = get('SELECT job FROM peer_effect_jobs WHERE effect = ?', reservation.effectKey);
          deleteEffect(reservation.effectKey);
          if (identity && reclaimableJobs(1, identity.job).length) run('DELETE FROM peer_jobs WHERE job = ?', identity.job);
          return;
        }
        run('UPDATE peer_effects SET state = ?, status = ?, response = ? WHERE effect = ?', retry ? 'retry' : 'complete', status, text, reservation.effectKey);
      });
    },
    // The context step only: an uncertain step (finished with its 503) whose
    // route reconciliation proved that a shutdown cut it before anything of it
    // was signed or sent runs again, under a fresh owner, as the same effect of
    // the same admission record, unless its seller session has ended. Only one
    // retry can take it; a step pending again stays fenced. Its earlier nonces
    // keep their 503 until it completes.
    resume(reservation, request) {
      requireJobId(request?.jobId);
      return transaction(() => {
        const current = get('SELECT * FROM peer_effects WHERE effect = ?', reservation.effectKey);
        if (request.path !== CONTEXT || reservation.disposition !== 'uncertain' || reservation.effectKey !== effectIdentity(request) ||
            !current || current.owner !== reservation.owner || current.state !== 'uncertain' || !admissions() ||
            get('SELECT effect FROM peer_context_admissions WHERE job = ? AND buyer = ?', request.jobId, request.buyer)?.effect !== reservation.effectKey) fail('peer_reconciliation_conflict', 503);
        if (TERMINAL_CONTEXT_STATES.has(contextSessionState({ jobId: request.jobId }))) fail('context_session_terminal', 409);
        const owner = randomBytes(24).toString('hex');
        run('UPDATE peer_effects SET owner = ?, state = ?, status = NULL, response = NULL WHERE effect = ?', owner, 'pending', reservation.effectKey);
        return { disposition: 'perform', effectKey: reservation.effectKey, owner, readOnly: false, resumed: true };
      });
    },
    close: () => db.close(),
    journaledOnlyReserve: true,
  };
}

/** Create request validation and response signing over a supplied store; throw on invalid configuration. */
export function createSellerTransportServerAuth({ sellerSigner, listingPin, store, now = () => Date.now(), maxLifetimeMs = MAX_TRANSPORT_LIFETIME_MS, requireDelegation = false }) {
  checkSigner(sellerSigner);
  if (!pinValid(listingPin) || !store?.reserve || !store?.finish || !uint(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > MAX_TRANSPORT_LIFETIME_MS) throw new Error('seller transport configuration is invalid');
  if (typeof requireDelegation !== 'boolean' || store.journaledOnlyReserve !== true) throw new Error('seller delegation configuration is invalid');
  const delegations = new WeakMap();
  const authenticatedRequests = new WeakMap();
  // Expired request or delegation: only read back effects already journaled for the job.
  const readbackOnly = new WeakSet();
  const isReadbackOnly = (request) => {
    if (!authenticatedRequests.has(request)) fail('peer_request_unauthenticated');
    const time = now();
    if (!uint(time) || request.expiresAt <= time || delegations.get(request)?.payload.expiresAt <= time) readbackOnly.add(request);
    return readbackOnly.has(request);
  };
  const refuseExpired = request => fail(delegations.get(request)?.payload.expiresAt <= now() ? 'peer_delegation_expired' : 'peer_expired', 408);
  const guardedStore = Object.freeze({
    bind: (value) => store.bind(value),
    issueContextChallenge: (request, ...args) => isReadbackOnly(request) ? refuseExpired(request) : store.issueContextChallenge(request, ...args),
    attemptContextPresentation: (request, ...args) => isReadbackOnly(request) ? refuseExpired(request) : store.attemptContextPresentation(request, ...args),
    reserve: (request, body, options = {}) => store.reserve(request, body, isReadbackOnly(request) ? { ...options, journaledOnly: true } : options),
    ...(typeof store.classify === 'function' ? { classify: (request, body, options = {}) => store.classify(request, body, isReadbackOnly(request) ? { ...options, journaledOnly: true } : options) } : {}),
    ...(typeof store.contextAdmission === 'function' ? { contextAdmission: (jobId) => store.contextAdmission(jobId) } : {}),
    ...(typeof store.contextAnswer === 'function' ? { contextAnswer: (jobId) => store.contextAnswer(jobId) } : {}),
    finish: (...args) => store.finish(...args),
    // Handing an effect back to the retry, or releasing it, lets a later claim run it: never for an expired delegation.
    ...(typeof store.reconcile === 'function' ? { reconcile: (reservation, request, status, text, options = {}) => isReadbackOnly(request) && (options.retry || options.noEffect)
      ? refuseExpired(request) : store.reconcile(reservation, request, status, text, options) } : {}),
    // Running a step again is new work: never for an expired delegation.
    ...(typeof store.resume === 'function' ? { resume: (reservation, request) => isReadbackOnly(request) ? refuseExpired(request) : store.resume(reservation, request) } : {}),
    close: () => store.close?.(),
  });
  const pin = clone(listingPin);
  store.bind({ seller: sellerSigner.claim, listingPin: pin });
  return {
    seller: sellerSigner.claim,
    listingPin: pin,
    store: guardedStore,
    requireDelegation,
    // True when request or delegation expiry permits only journaled readback;
    // reconciliation may complete retained work but cannot start an effect.
    readbackOnly: isReadbackOnly,
    readRequest(header) {
      const request = verifiedHeader(header, 'request', null, { requireDelegation, onDelegation: (request, delegation) => delegations.set(request, clone(delegation)) });
      authenticatedRequests.set(request, canonicalize(request));
      return request;
    },
    validate(request, { method, path, rawBody, body, agreement, onAuthenticatedBody, onRejectedBody }) {
      const authenticated = authenticatedRequests.get(request);
      if (authenticated === undefined) fail('peer_request_unauthenticated');
      let current;
      try { current = canonicalize(request); }
      catch (cause) { throw new SellerTransportError('peer_request_mismatch', 401, { cause }); }
      if (!payloadValid(request, 'request') || current !== authenticated) fail('peer_request_mismatch');
      requireJobId(request?.jobId);
      if (request.seller !== sellerSigner.claim) fail('peer_audience_wrong');
      if (request.method !== method || request.path !== path || request.bodyHash !== sha256Hex(rawBody)) fail('peer_request_mismatch');
      const time = now();
      // An expired retry can follow a previously completed effect. It is a
      // timeout/unknown answer, never proof that the operation was refused.
      if (!uint(time) || request.expiresAt <= time || request.expiresAt > time + maxLifetimeMs) fail('peer_expired', 408);
      if (!exact(request.listingPin, pin)) fail('peer_listing_mismatch', 409);
      let admittedBody;
      try {
        admittedBody = admitRawJson(rawBody);
        if (!exact(admittedBody, body)) fail('peer_body_mismatch', 409);
      } catch (cause) {
        if (cause instanceof SellerTransportError) throw cause;
        throw new SellerTransportError('peer_body_invalid', 409, { cause });
      }
      const delegation = delegations.get(request);
      if (requireDelegation && !delegation) fail('peer_delegation_required');
      if (delegation) {
        const draft = admittedBody.proposal?.plan?.draft;
        for (const artifact of [draft, agreement].filter((value) => value != null)) {
          if (artifact.jobId !== request.jobId || !exact(artifact.listingRef, pin) ||
              artifact.parties?.find((party) => party.role === 'buyer')?.primaryClaim !== request.buyer ||
              artifact.parties?.find((party) => party.role === 'seller')?.primaryClaim !== request.seller) fail('peer_delegation_agreement_mismatch', 409);
          if (!uint(artifact.terms?.deadline)) fail('peer_delegation_deadline', 409);
          verifySellerSessionDelegation(delegation, { deadline: artifact.terms.deadline });
        }
        verifySellerSessionDelegation(delegation, { buyer: request.buyer, seller: request.seller, listingPin: pin, jobId: request.jobId, time, allowExpired: true });
        // Live delegation: the request must also end by its expiry. Expired
        // delegation: readback of already journaled effects only (the store
        // refuses a new effect with peer_delegation_expired, 408).
        if (time < delegation.payload.expiresAt) {
          if (request.expiresAt > delegation.payload.expiresAt) fail('peer_delegation_expired', 408);
        } else readbackOnly.add(request);
      }
      try { validateBody(request,admittedBody); }
      catch(error) { onRejectedBody?.(admittedBody); throw error; }
      onAuthenticatedBody?.(admittedBody);
      return admittedBody;
    },
    async responseHeader(request, status, text) {
      requireJobId(request?.jobId);
      const payload = { ...clone(request), kind: 'response', bodyHash: sha256Hex(text), expiresAt: now() + maxLifetimeMs, requestHash: sha256Hex(canonicalize(request)), status };
      return signedHeader(payload, sellerSigner);
    },
  };
}

// A delegated app supplies only its session signer and the wallet-signed
// public delegation. Legacy fixtures may supply their own buyer signer.
// resolveJob comes from the approved Agreement, never an HTTP response.
/** Create signed requests and bound response verification; throw on invalid configuration. */
export function createSellerTransportClientAuth({ buyerSigner, sessionSigner, delegation, seller, resolveJob, now = () => Date.now(), lifetimeMs = DEFAULT_TRANSPORT_LIFETIME_MS, nonce = () => randomBytes(24).toString('base64url') }) {
  const signing = sessionSigner ?? buyerSigner;
  checkSigner(signing);
  if (sessionSigner && (buyerSigner || !delegation || signing.claim !== `did:demos:agent:${delegation.payload?.sessionPublicKey}`)) throw new Error('session signing key differs from the buyer delegation');
  if (!sessionSigner && delegation) throw new Error('a delegated request needs a session signing key');
  const buyer = sessionSigner ? verifySellerSessionDelegation(delegation).buyer : buyerSigner.claim;
  const retainedDelegation = delegation ? clone(delegation) : null;
  if (!isClaim(seller) || seller === buyer || typeof resolveJob !== 'function' || !uint(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > MAX_TRANSPORT_LIFETIME_MS) throw new Error('buyer transport configuration is invalid');
  return {
    async request(path, body, text) {
      if (!record(body)) fail('peer_body_invalid', 409);
      const jobId = [CONTEXT, SELLER_CONTEXT_CHALLENGE_PATH].includes(path) ? body.scope?.jobId : body.transportIdentity?.jobId ?? body.jobId;
      requireJobId(jobId);
      const context = clone(await resolveJob(jobId));
      const time = now();
      // An expired delegation still signs requests: the seller admits them
      // only to read back effects it already journaled for this job.
      if (retainedDelegation) verifySellerSessionDelegation(retainedDelegation, { buyer, seller, listingPin: context.listingPin, jobId, time, allowExpired: true, ...(context.deadline === undefined ? {} : { deadline: context.deadline }) });
      const live = !retainedDelegation || time < retainedDelegation.payload.expiresAt;
      const payload = { version: '1', kind: 'request', method: 'POST', path, bodyHash: sha256Hex(text), jobId, buyer, seller, listingPin: context.listingPin, agreementHash: context.agreementHash, nonce: nonce(), expiresAt: live ? Math.min(time + lifetimeMs, retainedDelegation?.payload.expiresAt ?? Number.MAX_SAFE_INTEGER) : time + lifetimeMs };
      return { payload, header: await signedHeader(payload, signing, retainedDelegation) };
    },
    verifyResponse(request, { header, status, text }) {
      requireJobId(request?.jobId);
      const response = verifiedHeader(header, 'response', seller);
      const { kind, bodyHash, expiresAt, requestHash, status: signedStatus, ...identity } = response;
      const { kind: requestKind, bodyHash: requestBodyHash, expiresAt: requestExpiry, ...expected } = request;
      const time = now();
      if (!exact(identity, expected) || requestHash !== sha256Hex(canonicalize(request)) || signedStatus !== status ||
          bodyHash !== sha256Hex(text) || !uint(time) || expiresAt <= time || expiresAt > time + MAX_TRANSPORT_LIFETIME_MS) fail('peer_response_mismatch');
      return { principal: seller, audience: buyer, messageId: request.nonce, messageHash: requestHash, authenticationHash: sha256Hex(header) };
    },
  };
}
