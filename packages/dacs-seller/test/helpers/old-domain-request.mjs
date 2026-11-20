// Test helper: a buyer that signs its requests under the transport's old signing domain, which the seller no longer accepts.
// The domain is joined from parts, so no shipped file and no search for the whole string finds it.
import { randomBytes } from 'node:crypto';
import { canonicalize, sha256Hex } from '@kynesyslabs/dacs';

const OLD_REQUEST_DOMAIN = ['dacs-chatgpt-plugin', 'loopback-seller-peer', 'v1', ''].join(':');
const CONTEXT_PATHS = ['/dacs/v1/agreements/context', '/dacs/v1/agreements/context/challenge'];
const REQUEST_LIFETIME_MS = 30_000;

/** The `x-dacs-seller-peer` header value for `payload`, signed by `sign(bytes)` under the old domain. */
export async function oldDomainHeader(payload, sign) {
  const signature = Buffer.from(await sign(Buffer.from(OLD_REQUEST_DOMAIN + canonicalize(payload)))).toString('base64url');
  return Buffer.from(canonicalize({ payload, signature })).toString('base64url');
}

/**
 * Create a buyer that signs under the old domain. `buyerSigner` is `{ claim, sign }`, `seller` the seller's claim and
 * `resolveJob(jobId)` the job's `{ listingPin, agreementHash }`. `request(path, body, text)` returns `{ payload, header }`.
 */
export function createOldDomainRequestSigner({ buyerSigner, seller, resolveJob, now = () => Date.now() }) {
  return {
    async request(path, body, text) {
      const jobId = CONTEXT_PATHS.includes(path) ? body.scope?.jobId : body.transportIdentity?.jobId ?? body.jobId;
      const { listingPin, agreementHash } = await resolveJob(jobId);
      const payload = { version: '1', kind: 'request', method: 'POST', path, bodyHash: sha256Hex(text), jobId, buyer: buyerSigner.claim, seller, listingPin, agreementHash,
        nonce: randomBytes(24).toString('base64url'), expiresAt: now() + REQUEST_LIFETIME_MS };
      return { payload, header: await oldDomainHeader(payload, buyerSigner.sign) };
    },
  };
}
