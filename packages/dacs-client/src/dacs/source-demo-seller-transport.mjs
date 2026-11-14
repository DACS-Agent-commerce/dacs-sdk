// Composition-only capability for the bounded source demo. It selects the
// existing cryptographically authenticated seller HTTP client; it does not
// weaken, replace or interpret that transport's request/response verdicts.
import { DACS_SELLER_HTTP_V1, DACS_SELLER_HTTP_DOMAINS } from '@kynesyslabs/dacs/wire';
const capabilities = new WeakSet();
/** The signed seller HTTP transport declaration retained in purchase terms. */
export const SOURCE_DEMO_SELLER_TRANSPORT = DACS_SELLER_HTTP_V1;

/** Returns an opaque wire capability with session signer, expiry policy and verified endpoint-proof resolvers. Throws TypeError for missing resolvers or a non-TEST authority. Construction sends nothing. */
export function createSourceDemoSellerTransport({ authority, sessionSignerFor, sessionPolicyFor, endpointProofFor }) {
  if (typeof authority !== 'string' || !authority.startsWith('TEST-')) throw new TypeError('source demo seller transport requires explicit TEST authority');
  if (![sessionSignerFor, sessionPolicyFor, endpointProofFor].every(member => typeof member === 'function')) throw new TypeError('seller transport requires session signer, policy and endpoint proof resolvers');
  const declaration = Object.freeze({ profile: SOURCE_DEMO_SELLER_TRANSPORT, authority,
    request: DACS_SELLER_HTTP_DOMAINS.request, delegation: DACS_SELLER_HTTP_DOMAINS.delegation, response: DACS_SELLER_HTTP_DOMAINS.response, durability: 'seller-intent-journal' });
  const capability = Object.freeze({ declaration, sessionSignerFor, sessionPolicyFor, endpointProofFor });
  capabilities.add(capability);
  return capability;
}

export function sourceDemoSellerTransportConfig(value) {
  if (value == null) return null;
  if (!capabilities.has(value)) throw new TypeError('sellerTransport requires a constructed signed-peer capability');
  return value;
}
