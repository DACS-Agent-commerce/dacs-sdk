// Private, loopback-only adapter profile, not a DACS wire protocol. The pinned
// SDK paymentEvidenceHandshake delegates peer authentication to its host and
// only supports x402 evidence anchoring. This DEM transport uses its canonical
// hashing primitives, with a separate buyer/seller Ed25519 signing callback.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { constants, closeSync, lstatSync, openSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { admitRawJson, RawJsonAdmissionError, canonicalize, createFixedPriceAgreementSigningPlan, isCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { decodeSignature } from '../signatures.mjs';
import { assertSellerSessionLifetime } from './seller-session-limits.mjs';

export const SELLER_TRANSPORT_HEADER = 'x-dacs-seller-peer';
export const SELLER_TRANSPORT_MAX_RESPONSE = 512 * 1024;
const DOMAIN = 'dacs-chatgpt-plugin:loopback-seller-peer:v1:';
const DELEGATION_DOMAIN = 'dacs-chatgpt-plugin:seller-session-delegation:v1:';
const HASH = /^[0-9a-f]{64}$/;
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{22,86}$/;
const PROPOSAL = '/dacs/v1/agreements/proposals';
const STATE = '/dacs/v1/agreements/state';
const PAYMENT = '/dacs/v1/payments';
const READ_ROUTES = new Set([STATE, '/dacs/v1/bundles/buyer-copy']);
const exact = (a, b) => canonicalize(a) === canonicalize(b);
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, expected) => record(v) && Object.keys(v).length === expected.length && expected.every((k) => Object.hasOwn(v, k));
const uint = (v) => Number.isSafeInteger(v) && v >= 0 && !Object.is(v, -0);
const clone = (v) => JSON.parse(JSON.stringify(v));
const fail = (code, status = 401) => { throw new SellerTransportError(code, status); };

export class SellerTransportError extends Error {
  constructor(code, status = 401) { super(code); this.code = code; this.status = status; }
}

function pinValid(pin) {
  return keys(pin, ['listingId', 'version', 'contentHash']) &&
    typeof pin.listingId === 'string' && pin.listingId.length > 0 && pin.listingId.length <= 256 &&
    uint(pin.version) && pin.version > 0 && typeof pin.contentHash === 'string' && HASH.test(pin.contentHash);
}

function payloadValid(p, kind) {
  const fields = ['version', 'kind', 'method', 'path', 'bodyHash', 'jobId', 'buyer', 'seller', 'listingPin', 'agreementHash', 'nonce', 'expiresAt'];
  if (kind === 'response') fields.push('requestHash', 'status');
  return ['request', 'response'].includes(kind) && keys(p, fields) && p.version === '1' && p.kind === kind && p.method === 'POST' &&
    typeof p.path === 'string' && /^\/dacs\/v1\/[a-z/-]+$/.test(p.path) && p.path.length <= 160 &&
    HASH.test(p.bodyHash) && isCanonicalJobId(p.jobId) && CLAIM.test(p.buyer) && CLAIM.test(p.seller) && p.buyer !== p.seller &&
    pinValid(p.listingPin) && HASH.test(p.agreementHash) && NONCE.test(p.nonce) &&
    Buffer.from(p.nonce, 'base64url').toString('base64url') === p.nonce && uint(p.expiresAt) &&
    (kind !== 'response' || (HASH.test(p.requestHash) && uint(p.status) && p.status >= 200 && p.status <= 599));
}

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
  if (typeof header !== 'string' || header.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(header)) fail('peer_envelope_invalid');
  const bytes = Buffer.from(header, 'base64url');
  if (bytes.toString('base64url') !== header) fail('peer_envelope_invalid');
  let envelope;
  try { envelope = admitRawJson(bytes, { maxBytes: 4096 }); } catch (cause) {
    const error = new SellerTransportError('peer_envelope_invalid');
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
  const publicKey = publicKeyFor(delegation?.sessionPublicKey ?? actor.slice('did:demos:agent:'.length));
  if (!verify(null, sellerTransportSigningBytes(p), publicKey, signatureBytes(envelope.signature))) fail('peer_signature_invalid');
  if (delegation) onDelegation?.(p, envelope.delegation);
  return p;
}

function publicKeyFor(raw) {
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'hex')]), format: 'der', type: 'spki' });
}

export function sellerSessionDelegationSigningBytes(payload) {
  if (!keys(payload, ['version', 'kind', 'buyer', 'sessionPublicKey', 'seller', 'listingPin', 'jobId', 'notBefore', 'expiresAt']) ||
      payload.version !== '1' || payload.kind !== 'seller-session-delegation' || typeof payload.buyer !== 'string' || typeof payload.seller !== 'string' || !CLAIM.test(payload.buyer) || !CLAIM.test(payload.seller) ||
      payload.buyer === payload.seller || typeof payload.sessionPublicKey !== 'string' || !HASH.test(payload.sessionPublicKey) || !pinValid(payload.listingPin) || !isCanonicalJobId(payload.jobId) ||
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

export function normalizeSellerSessionDelegationSignature(signature) {
  return delegationSignatureBytes(signature).toString('base64url');
}

// time: also require notBefore <= time < expiresAt. allowExpired keeps only
// the notBefore check; it is for readback of already journaled effects (see
// docs/SELLER-SESSION-DELEGATION.md), never for starting a new seller effect.
export function verifySellerSessionDelegation(delegation, { buyer, seller, listingPin, jobId, time, deadline, allowExpired = false } = {}) {
  if (!keys(delegation, ['payload', 'signature'])) fail('peer_delegation_invalid');
  const p = delegation.payload, bytes = sellerSessionDelegationSigningBytes(p);
  if (!verify(null, bytes, publicKeyFor(p.buyer.slice('did:demos:agent:'.length)), delegationSignatureBytes(delegation.signature))) fail('peer_delegation_signature_invalid');
  if ((buyer !== undefined && p.buyer !== buyer) || (seller !== undefined && p.seller !== seller) ||
      (listingPin !== undefined && !exact(p.listingPin, listingPin)) || (jobId !== undefined && p.jobId !== jobId)) fail('peer_delegation_mismatch', 409);
  if (time !== undefined && (!uint(time) || p.notBefore > time || (!allowExpired && p.expiresAt <= time))) fail('peer_delegation_expired', 408);
  if (deadline !== undefined && (!uint(deadline) || p.expiresAt > deadline)) fail('peer_delegation_deadline', 409);
  return clone(p);
}

function checkSigner(signer) {
  if (!CLAIM.test(signer?.claim) || typeof signer.sign !== 'function') throw new Error('a separate Demos Ed25519 signing callback is required');
}

function requestIdentity(p) {
  return { jobId: p.jobId, buyer: p.buyer, seller: p.seller, listingPin: p.listingPin, agreementHash: p.agreementHash };
}

const effectIdentity = (p) => sha256Hex(canonicalize({ ...requestIdentity(p), method: p.method, path: p.path, bodyHash: p.bodyHash }));

function validateBody(p, body) {
  const identity = body.transportIdentity;
  if ((identity?.jobId ?? body.jobId) !== p.jobId) fail('peer_job_mismatch', 409);
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

// A host-local durable intent journal. No private key, wallet token or signing
// callback is persisted. Atomic intent precedes agent invocation. A pending or
// ambiguous effect never expires into permission to run it again. Completed
// responses can be re-signed for a fresh nonce after a process restart. This
// journal does not reconstruct the seller agent's protocol/session stores.
export function createSellerTransportStore({ path, maxRecords = 10000 }) {
  if (typeof path !== 'string' || !isAbsolute(path) || !uint(maxRecords) || maxRecords === 0) throw new Error('a persistent absolute path and positive store capacity are required');
  const parent = dirname(path);
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      directory.uid !== process.getuid?.() || realpathSync(parent) !== parent) throw new Error('transport store needs a private, real host-local directory');
  try {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 || file.uid !== process.getuid?.()) throw new Error('transport store file must be private and regular');
  // Only server journal construction needs SQLite; the root import does not load it.
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 1000');
  db.exec(`CREATE TABLE IF NOT EXISTS peer_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peer_jobs (job TEXT PRIMARY KEY, context TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peer_effects (effect TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, status INTEGER, response TEXT);
    CREATE TABLE IF NOT EXISTS peer_slots (slot TEXT PRIMARY KEY, effect TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peer_transactions (tx TEXT PRIMARY KEY, job TEXT NOT NULL, effect TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS peer_nonces (nonce TEXT PRIMARY KEY, request_hash TEXT NOT NULL, effect TEXT NOT NULL, status INTEGER, response TEXT);`);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  return {
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
    reserve(p, body, { journaledOnly = false } = {}) {
      return transaction(() => {
        const requestHash = sha256Hex(canonicalize(p));
        const nonce = `${p.buyer}:${p.nonce}`;
        const previous = get('SELECT * FROM peer_nonces WHERE nonce = ?', nonce);
        if (previous) {
          if (previous.request_hash !== requestHash) fail('peer_nonce_conflict', 409);
          // A definite earlier no-effect answer belongs to its own nonce,
          // even if a fresh attempt of the same command later succeeds.
          if (previous.response !== null && previous.status < 500) return { disposition: 'cached', status: previous.status, text: previous.response };
          const effect = get('SELECT * FROM peer_effects WHERE effect = ?', previous.effect);
          if (effect?.state === 'complete') return { disposition: 'cached', status: effect.status, text: effect.response };
          if (effect) return { disposition: 'uncertain', effectKey: effect.effect, owner: effect.owner };
          if (previous.response !== null) return { disposition: 'cached', status: previous.status, text: previous.response };
          return { disposition: 'uncertain' };
        }
        if (get('SELECT COUNT(*) AS n FROM peer_nonces').n >= maxRecords) fail('peer_store_capacity', 503);
        const context = canonicalize(requestIdentity(p));
        const job = get('SELECT context FROM peer_jobs WHERE job = ?', p.jobId);
        if (job && job.context !== context) fail('peer_job_conflict', 409);
        const effectKey = effectIdentity(p);
        if (journaledOnly && !READ_ROUTES.has(p.path) && !get('SELECT effect FROM peer_effects WHERE effect = ?', effectKey)) fail('peer_delegation_expired', 408);
        // The SDK buyer coordinator reconciles before publishing a proposal.
        // An unadmitted job has no authenticated state to disclose or reserve.
        if (!job && p.path === STATE) {
          const text = '{"proposal":null,"contribution":null}';
          run('INSERT INTO peer_nonces VALUES (?, ?, ?, ?, ?)', nonce, requestHash, effectKey, 200, text);
          return { disposition: 'cached', status: 200, text };
        }
        if (!job && p.path !== PROPOSAL) fail('peer_unknown_job', 404);
        const slot = `${p.jobId}:${p.path}`;
        const occupied = READ_ROUTES.has(p.path) ? null : get('SELECT effect FROM peer_slots WHERE slot = ?', slot);
        if (occupied && occupied.effect !== effectKey) fail('peer_operation_conflict', 409);
        if (p.path === PAYMENT) {
          const tx = body.txHash.replace(/^0x/, '').toLowerCase();
          const claimed = get('SELECT job, effect FROM peer_transactions WHERE tx = ?', tx);
          if (claimed && (claimed.job !== p.jobId || claimed.effect !== effectKey)) fail('peer_payment_conflict', 409);
          if (!claimed) run('INSERT INTO peer_transactions VALUES (?, ?, ?)', tx, p.jobId, effectKey);
        }
        if (!job) run('INSERT INTO peer_jobs VALUES (?, ?)', p.jobId, context);
        const existing = get('SELECT * FROM peer_effects WHERE effect = ?', effectKey);
        run('INSERT INTO peer_nonces VALUES (?, ?, ?, NULL, NULL)', nonce, requestHash, effectKey);
        if (existing) return existing.state === 'complete' ? { disposition: 'cached', status: existing.status, text: existing.response } : { disposition: 'uncertain', effectKey, owner: existing.owner };
        const owner = randomBytes(24).toString('hex');
        run('INSERT INTO peer_effects VALUES (?, ?, ?, NULL, NULL)', effectKey, owner, 'pending');
        if (!READ_ROUTES.has(p.path) && !occupied) run('INSERT INTO peer_slots VALUES (?, ?)', slot, effectKey);
        return { disposition: 'perform', effectKey, owner, readOnly: READ_ROUTES.has(p.path) };
      });
    },
    finish(reservation, status, text, { noEffect = false } = {}) {
      if (Buffer.byteLength(text) > SELLER_TRANSPORT_MAX_RESPONSE) fail('peer_response_too_large', 503);
      transaction(() => {
        const current = get('SELECT * FROM peer_effects WHERE effect = ?', reservation.effectKey);
        if (!current || current.owner !== reservation.owner || current.state !== 'pending') fail('peer_store_conflict', 503);
        run('UPDATE peer_nonces SET status = ?, response = ? WHERE effect = ? AND response IS NULL', status, text, reservation.effectKey);
        if (noEffect || reservation.readOnly) {
          run('DELETE FROM peer_effects WHERE effect = ?', reservation.effectKey);
          run('DELETE FROM peer_slots WHERE effect = ?', reservation.effectKey);
          run('DELETE FROM peer_transactions WHERE effect = ?', reservation.effectKey);
        } else {
          run('UPDATE peer_effects SET state = ?, status = ?, response = ? WHERE effect = ?', status >= 500 ? 'uncertain' : 'complete', status, text, reservation.effectKey);
        }
      });
    },
    // The host may resolve only the SAME retained operation, after its seller
    // reducer has authenticated durable context and fresh native readback. No
    // reservation, slot or transaction is released; no expired intent retries.
    reconcile(reservation, request, status, text) {
      if (status !== 200 || Buffer.byteLength(text) > SELLER_TRANSPORT_MAX_RESPONSE) fail('peer_reconciliation_invalid', 503);
      transaction(() => {
        const current = get('SELECT * FROM peer_effects WHERE effect = ?', reservation.effectKey);
        if (reservation.disposition !== 'uncertain' || reservation.effectKey !== effectIdentity(request) ||
            !current || current.owner !== reservation.owner || !['pending', 'uncertain'].includes(current.state) ||
            get('SELECT context FROM peer_jobs WHERE job = ?', request.jobId)?.context !== canonicalize(requestIdentity(request))) fail('peer_reconciliation_conflict', 503);
        run('UPDATE peer_effects SET state = ?, status = ?, response = ? WHERE effect = ?', 'complete', status, text, reservation.effectKey);
        run('UPDATE peer_nonces SET status = ?, response = ? WHERE effect = ? AND (response IS NULL OR status >= 500)', status, text, reservation.effectKey);
      });
    },
    close: () => db.close(),
    journaledOnlyReserve: true,
  };
}

export function createSellerTransportServerAuth({ sellerSigner, listingPin, store, now = () => Date.now(), maxLifetimeMs = 60000, requireDelegation = false }) {
  checkSigner(sellerSigner);
  if (!pinValid(listingPin) || !store?.reserve || !store?.finish || !uint(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > 60000) throw new Error('seller transport configuration is invalid');
  if (typeof requireDelegation !== 'boolean' || (requireDelegation && store.journaledOnlyReserve !== true)) throw new Error('seller delegation configuration is invalid');
  const delegations = new WeakMap();
  // Requests authenticated by an expired delegation; the store admits them
  // only for readback of effects already journaled for the job.
  const readbackOnly = new WeakSet();
  const guardedStore = Object.freeze({
    bind: (value) => store.bind(value),
    reserve: (request, body) => readbackOnly.has(request) ? store.reserve(request, body, { journaledOnly: true }) : store.reserve(request, body),
    finish: (...args) => store.finish(...args),
    ...(typeof store.reconcile === 'function' ? { reconcile: (...args) => store.reconcile(...args) } : {}),
    close: () => store.close?.(),
  });
  const pin = clone(listingPin);
  store.bind({ seller: sellerSigner.claim, listingPin: pin });
  return {
    seller: sellerSigner.claim,
    listingPin: pin,
    store: requireDelegation ? guardedStore : store,
    requireDelegation,
    readRequest: (header) => verifiedHeader(header, 'request', null, { requireDelegation, onDelegation: (request, delegation) => delegations.set(request, clone(delegation)) }),
    validate(request, { method, path, rawBody, body, agreement }) {
      if (request.seller !== sellerSigner.claim) fail('peer_audience_wrong');
      const time = now();
      // An expired retry can follow a previously completed effect. It is a
      // timeout/unknown answer, never proof that the operation was refused.
      if (!uint(time) || request.expiresAt <= time || request.expiresAt > time + maxLifetimeMs) fail('peer_expired', 408);
      if (request.method !== method || request.path !== path || request.bodyHash !== sha256Hex(rawBody)) fail('peer_request_mismatch');
      if (!exact(request.listingPin, pin)) fail('peer_listing_mismatch', 409);
      validateBody(request, body);
      const delegation = delegations.get(request);
      if (requireDelegation && !delegation) fail('peer_delegation_required');
      if (delegation) {
        const draft = body.proposal?.plan?.draft;
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
    },
    async responseHeader(request, status, text) {
      const payload = { ...clone(request), kind: 'response', bodyHash: sha256Hex(text), expiresAt: now() + maxLifetimeMs, requestHash: sha256Hex(canonicalize(request)), status };
      return signedHeader(payload, sellerSigner);
    },
  };
}

// A delegated app supplies only its session signer and the wallet-signed
// public delegation. Legacy fixtures may supply their own buyer signer.
// resolveJob comes from the approved Agreement, never an HTTP response.
export function createSellerTransportClientAuth({ buyerSigner, sessionSigner, delegation, seller, resolveJob, now = () => Date.now(), lifetimeMs = 30000, nonce = () => randomBytes(24).toString('base64url') }) {
  const signing = sessionSigner ?? buyerSigner;
  checkSigner(signing);
  if (sessionSigner && (buyerSigner || !delegation || signing.claim !== `did:demos:agent:${delegation.payload?.sessionPublicKey}`)) throw new Error('session signing key differs from the buyer delegation');
  if (!sessionSigner && delegation) throw new Error('a delegated request needs a session signing key');
  const buyer = sessionSigner ? verifySellerSessionDelegation(delegation).buyer : buyerSigner.claim;
  const retainedDelegation = delegation ? clone(delegation) : null;
  if (!CLAIM.test(seller) || seller === buyer || typeof resolveJob !== 'function' || !uint(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 60000) throw new Error('buyer transport configuration is invalid');
  return {
    async request(path, body, text) {
      const jobId = body.transportIdentity?.jobId ?? body.jobId;
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
      const response = verifiedHeader(header, 'response', seller);
      const { kind, bodyHash, expiresAt, requestHash, status: signedStatus, ...identity } = response;
      const { kind: requestKind, bodyHash: requestBodyHash, expiresAt: requestExpiry, ...expected } = request;
      const time = now();
      if (!exact(identity, expected) || requestHash !== sha256Hex(canonicalize(request)) || signedStatus !== status ||
          bodyHash !== sha256Hex(text) || !uint(time) || expiresAt <= time || expiresAt > time + 60000) fail('peer_response_mismatch');
      return { principal: seller, audience: buyer, messageId: request.nonce, messageHash: requestHash, authenticationHash: sha256Hex(header) };
    },
  };
}
