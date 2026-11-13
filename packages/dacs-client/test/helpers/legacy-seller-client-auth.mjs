// Archived buyer implementation for legacy server fixtures only. Never shipped.
import { randomBytes, createPublicKey, verify } from 'node:crypto';
import { canonicalize, sha256Hex, admitRawJson } from '@kynesyslabs/dacs';
import { sellerTransportSigningBytes, verifySellerSessionDelegation, SellerTransportError } from '../../../dacs-seller/src/dacs/seller-transport-auth.mjs';
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
const clone = value => JSON.parse(JSON.stringify(value));
const exact = (a, b) => canonicalize(a) === canonicalize(b);
const uint = value => Number.isSafeInteger(value) && value >= 0;
const without = (record, keys) => Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
const fail = code => {
  throw new SellerTransportError(code);
};
const checkSigner = signer => {
  if (!CLAIM.test(signer?.claim) || typeof signer?.sign !== 'function')
    throw Error('fixture signer invalid');
};
const signatureBytes = value => value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value, 'base64url');
async function signedHeader(payload, signer, delegation) {
  const signature = signatureBytes(await signer.sign(sellerTransportSigningBytes(payload))).toString('base64url');
  return Buffer.from(canonicalize({ payload, signature, ...(delegation ? { delegation } : {}) })).toString('base64url');
}
function verifiedHeader(header, kind, principal) {
  const envelope = admitRawJson(Buffer.from(header, 'base64url'), { maxBytes: 4096 });
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(principal.slice('did:demos:agent:'.length), 'hex')]), format: 'der', type: 'spki' });
  if (envelope.payload.kind !== kind || envelope.payload.seller !== principal || !verify(null, sellerTransportSigningBytes(envelope.payload), key, signatureBytes(envelope.signature)))
    fail('peer_signature_invalid');
  return envelope.payload;
}
// A delegated app supplies only its session signer and the wallet-signed
// public delegation. Legacy fixtures may supply their own buyer signer.
// resolveJob comes from the approved Agreement, never an HTTP response.
export function createSellerTransportClientAuth({ buyerSigner, sessionSigner, delegation, seller, resolveJob, now = () => Date.now(), lifetimeMs = 30000, nonce = () => randomBytes(24).toString('base64url') }) {
  const signing = sessionSigner ?? buyerSigner;
  checkSigner(signing);
  if (sessionSigner && (buyerSigner || !delegation || signing.claim !== `did:demos:agent:${delegation.payload?.sessionPublicKey}`))
    throw new Error('session signing key differs from the buyer delegation');
  if (!sessionSigner && delegation)
    throw new Error('a delegated request needs a session signing key');
  const buyer = sessionSigner ? verifySellerSessionDelegation(delegation).buyer : buyerSigner.claim;
  const retainedDelegation = delegation ? clone(delegation) : null;
  if (!CLAIM.test(seller) || seller === buyer || typeof resolveJob !== 'function' || !uint(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 60000)
    throw new Error('buyer transport configuration is invalid');
  return {
    async request(path, body, text) {
      const jobId = body.transportIdentity?.jobId ?? body.jobId;
      const context = clone(await resolveJob(jobId));
      const time = now();
      // An expired delegation still signs requests: the seller admits them
      // only to read back effects it already journaled for this job.
      if (retainedDelegation)
        verifySellerSessionDelegation(retainedDelegation, { buyer, seller, listingPin: context.listingPin, jobId, time, allowExpired: true, ...(context.deadline === undefined ? {} : { deadline: context.deadline }) });
      const live = !retainedDelegation || time < retainedDelegation.payload.expiresAt;
      const payload = {
        version: '1', kind: 'request', method: 'POST', path, bodyHash: sha256Hex(text), jobId, buyer, seller, listingPin: context.listingPin, agreementHash: context.agreementHash, nonce: nonce(), expiresAt: live ? Math.min(time + lifetimeMs, retainedDelegation?.payload.expiresAt ?? Number.MAX_SAFE_INTEGER) : time + lifetimeMs
      };
      return { payload, header: await signedHeader(payload, signing, retainedDelegation) };
    },
    verifyResponse(request, { header, status, text, body }) {
      text ??= Buffer.from(body).toString('utf8');
      const response = verifiedHeader(header, 'response', seller);
      const identity = without(response, ['kind', 'bodyHash', 'expiresAt', 'requestHash', 'status']);
      const expected = without(request, ['kind', 'bodyHash', 'expiresAt']);
      const time = now();
      if (!exact(identity, expected) || response.requestHash !== sha256Hex(canonicalize(request)) || response.status !== status ||
        response.bodyHash !== sha256Hex(text) || !uint(time) || response.expiresAt <= time || response.expiresAt > time + 60000)
        fail('peer_response_mismatch');
      return {
        principal: seller, audience: buyer, messageId: request.nonce, messageHash: response.requestHash, authenticationHash: sha256Hex(header), ...(body ? { body: admitRawJson(body, { maxBytes: 512 * 1024 }) } : {})
      };
    },
  };
}
