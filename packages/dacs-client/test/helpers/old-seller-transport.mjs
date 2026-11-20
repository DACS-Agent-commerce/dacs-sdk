// Test-only copy of the old seller transport's signing bytes and delegation check, for the fixtures that sign and verify
// under the old signing domains. It is never shipped; the seller package no longer has these helpers.
import { createPublicKey } from 'node:crypto';
import { canonicalize, ed25519Verify, isCanonicalJobId } from '@kynesyslabs/dacs';
import { assertSellerSessionLifetime } from '../../src/dacs/seller-session-limits.mjs';
import { decodeSignature } from '../../src/signatures.mjs';

export const SELLER_TRANSPORT_HEADER = 'x-dacs-seller-peer';
const DOMAIN = ['dacs-chatgpt-plugin', 'loopback-seller-peer', 'v1', ''].join(':');
const DELEGATION_DOMAIN = ['dacs-chatgpt-plugin', 'seller-session-delegation', 'v1', ''].join(':');
const HASH = /^[0-9a-f]{64}$/;
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{22,86}$/;
const P25519 = 2n ** 255n - 19n, Y8 = 2707385501144840649318225287225658788936804267575313519463743609750303402022n;
const SMALL_ORDER_Y = new Set([0n, 1n, P25519 - 1n, Y8, P25519 - Y8]);
const isHash = value => typeof value === 'string' && HASH.test(value);
const isClaim = value => typeof value === 'string' && CLAIM.test(value);
const isNonce = value => typeof value === 'string' && NONCE.test(value);
const exact = (a, b) => canonicalize(a) === canonicalize(b);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => record(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const uint = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const clone = value => JSON.parse(JSON.stringify(value));
const fail = (code, status = 401) => { throw new SellerTransportError(code, status); };

/** A refusal with a stable code and HTTP status. */
export class SellerTransportError extends Error {
  constructor(code, status = 401, options) { super(code, options); this.code = code; this.status = status; }
}

const isSmallOrderPublicKey = raw => SMALL_ORDER_Y.has((BigInt(`0x${Buffer.from(raw).reverse().toString('hex')}`) & ((1n << 255n) - 1n)) % P25519);
const pinValid = pin => keys(pin, ['listingId', 'version', 'contentHash']) &&
  typeof pin.listingId === 'string' && pin.listingId.length > 0 && pin.listingId.length <= 256 &&
  uint(pin.version) && pin.version > 0 && isHash(pin.contentHash);

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

/** The bytes a request or response envelope payload is signed over; throws `peer_envelope_invalid` for a malformed payload. */
export function sellerTransportSigningBytes(payload) {
  if (!payloadValid(payload, payload?.kind)) fail('peer_envelope_invalid');
  return Buffer.from(`${DOMAIN}${canonicalize(payload)}`, 'utf8');
}

// The Ed25519 key of a 64-digit hex public key; a small-order key is refused with `code`.
function publicKeyFor(raw, code) {
  if (isSmallOrderPublicKey(Buffer.from(raw, 'hex'))) fail(code);
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw, 'hex')]), format: 'der', type: 'spki' });
}

/** The bytes a delegation payload is signed over; throws `peer_delegation_invalid` for an invalid scope or lifetime. */
export function sellerSessionDelegationSigningBytes(payload) {
  if (!keys(payload, ['version', 'kind', 'buyer', 'sessionPublicKey', 'seller', 'listingPin', 'jobId', 'notBefore', 'expiresAt']) ||
      payload.version !== '1' || payload.kind !== 'seller-session-delegation' || !isClaim(payload.buyer) || !isClaim(payload.seller) ||
      payload.buyer === payload.seller || !isHash(payload.sessionPublicKey) || !pinValid(payload.listingPin) || !isCanonicalJobId(payload.jobId) ||
      !uint(payload.notBefore) || !uint(payload.expiresAt) || payload.expiresAt <= payload.notBefore) fail('peer_delegation_invalid');
  try { assertSellerSessionLifetime(payload.expiresAt - payload.notBefore); } catch { fail('peer_delegation_invalid'); }
  return Buffer.from(`${DELEGATION_DOMAIN}${canonicalize(payload)}`, 'utf8');
}

function delegationSignatureBytes(signature) {
  try { return decodeSignature(signature); } catch { fail('peer_delegation_signature_invalid'); }
}

/**
 * Authenticate a delegation's signature, scope and optional time bounds; return a copy of its payload or throw a
 * `SellerTransportError`. With `allowExpired`, only `notBefore` is checked against `time`.
 */
export function verifySellerSessionDelegation(delegation, { buyer, seller, listingPin, jobId, time, deadline, allowExpired = false } = {}) {
  if (!keys(delegation, ['payload', 'signature'])) fail('peer_delegation_invalid');
  const p = delegation.payload, bytes = sellerSessionDelegationSigningBytes(p);
  if (!ed25519Verify(bytes, delegationSignatureBytes(delegation.signature), publicKeyFor(p.buyer.slice('did:demos:agent:'.length), 'peer_delegation_signature_invalid'))) fail('peer_delegation_signature_invalid');
  if ((buyer !== undefined && p.buyer !== buyer) || (seller !== undefined && p.seller !== seller) ||
      (listingPin !== undefined && !exact(p.listingPin, listingPin)) || (jobId !== undefined && p.jobId !== jobId)) fail('peer_delegation_mismatch', 409);
  if (time !== undefined && (!uint(time) || p.notBefore > time || (!allowExpired && p.expiresAt <= time))) fail('peer_delegation_expired', 408);
  if (deadline !== undefined && (!uint(deadline) || p.expiresAt > deadline)) fail('peer_delegation_deadline', 409);
  return clone(p);
}
