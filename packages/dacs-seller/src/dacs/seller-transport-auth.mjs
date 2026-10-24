// Private, loopback-only adapter profile, not a DACS wire protocol. The pinned
// SDK paymentEvidenceHandshake delegates peer authentication to its host and
// only supports x402 evidence anchoring. This DEM transport uses its canonical
// hashing primitives, with a separate buyer/seller Ed25519 signing callback.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { admitRawJson, RawJsonAdmissionError, canonicalize, createFixedPriceAgreementSigningPlan, isCanonicalJobId, sha256Hex } from '@kynesyslabs/dacs';
import { decodeSignature } from './demos-claims.mjs';
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
  const publicKey = publicKeyFor(delegation?.sessionPublicKey ?? actor.slice('did:demos:agent:'.length));
  if (!verify(null, sellerTransportSigningBytes(p), publicKey, signatureBytes(envelope.signature))) fail('peer_signature_invalid');
  if (delegation) onDelegation?.(p, envelope.delegation);
  return p;
}

function publicKeyFor(raw) {
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
  if (!verify(null, bytes, publicKeyFor(p.buyer.slice('did:demos:agent:'.length)), delegationSignatureBytes(delegation.signature))) fail('peer_delegation_signature_invalid');
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

/** Create request validation and response signing over a supplied store; throw on invalid configuration. */
export function createSellerTransportServerAuth({ sellerSigner, listingPin, store, now = () => Date.now(), maxLifetimeMs = MAX_TRANSPORT_LIFETIME_MS, requireDelegation = false }) {
  checkSigner(sellerSigner);
  if (!pinValid(listingPin) || !store?.reserve || !store?.finish || !uint(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > MAX_TRANSPORT_LIFETIME_MS) throw new Error('seller transport configuration is invalid');
  if (typeof requireDelegation !== 'boolean' || (requireDelegation && store.journaledOnlyReserve !== true)) throw new Error('seller delegation configuration is invalid');
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
    validate(request, { method, path, rawBody, body, agreement, onAuthenticatedBody }) {
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
      validateBody(request, admittedBody);
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
