// Composition-only capability for the bounded source demo. It selects the
// existing cryptographically authenticated seller HTTP client; it does not
// weaken, replace or interpret that transport's request/response verdicts.
import { DACS_SELLER_HTTP_V1, DACS_SELLER_HTTP_DOMAINS } from '@kynesyslabs/dacs/wire';
import { authorityLabel } from './tp1-authority-token.mjs';
const capabilities = new WeakSet();
/** The signed seller HTTP transport declaration retained in purchase terms. */
export const SOURCE_DEMO_SELLER_TRANSPORT = DACS_SELLER_HTTP_V1;

const isFixtureLabel = value => typeof value === 'string' && value.startsWith('TEST-');

/** Returns an opaque wire capability with session signer, expiry policy and verified endpoint-proof resolvers, and the client's effect boundary through which every request signature passes. `authority` is a `TEST-` label or a token admitted for `binding`; the declaration holds its label. Throws TypeError for missing resolvers, a missing effect boundary or any other authority, OperationError(authority_unbound) for a `TP1-` label string or a token of another binding, and OperationError(profile_not_admitted) for a token while purchases are held. Construction sends nothing. */
export function createSourceDemoSellerTransport({ authority, binding, sessionSignerFor, sessionPolicyFor, endpointProofFor, effectBoundary }) {
  const label = authorityLabel(authority, binding, isFixtureLabel, 'source demo seller transport requires a TEST authority or an authority token');
  if (![sessionSignerFor, sessionPolicyFor, endpointProofFor].every(member => typeof member === 'function')) throw new TypeError('seller transport requires session signer, policy and endpoint proof resolvers');
  if (typeof effectBoundary?.signerFor !== 'function') throw new TypeError('seller transport requires the client effect boundary');
  const declaration = Object.freeze({ profile: SOURCE_DEMO_SELLER_TRANSPORT, authority: label,
    request: DACS_SELLER_HTTP_DOMAINS.request, delegation: DACS_SELLER_HTTP_DOMAINS.delegation, response: DACS_SELLER_HTTP_DOMAINS.response, durability: 'seller-intent-journal' });
  const capability = Object.freeze({ declaration, sessionSignerFor, sessionPolicyFor, endpointProofFor, effectBoundary });
  capabilities.add(capability);
  return capability;
}

export function sourceDemoSellerTransportConfig(value) {
  if (value == null) return null;
  if (!capabilities.has(value)) throw new TypeError('sellerTransport requires a constructed signed-peer capability');
  return value;
}
