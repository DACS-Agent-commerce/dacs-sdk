// Composition-only capability for the bounded source demo. It selects the
// existing cryptographically authenticated seller HTTP client; it does not
// weaken, replace or interpret that transport's request/response verdicts.
const capabilities = new WeakSet();
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

export const SOURCE_DEMO_SELLER_TRANSPORT = 'dacs-source-demo/signed-peer/v1';

export function createSourceDemoSellerTransport({ authority, authenticationFor, sessionDelegation = null }) {
  if (typeof authority !== 'string' || !authority.startsWith('TEST-') || typeof authenticationFor !== 'function') {
    throw new TypeError('source demo seller transport requires explicit TEST authority and an authentication resolver');
  }
  if (sessionDelegation != null && (!exact(sessionDelegation, ['request', 'accept']) || !['request', 'accept'].every((name) => typeof sessionDelegation[name] === 'function'))) throw new TypeError('seller session delegation requires exact request and accept callbacks');
  const declaration = Object.freeze({ profile: SOURCE_DEMO_SELLER_TRANSPORT, authority,
    request: sessionDelegation ? 'buyer-delegated-session-ed25519-complete-body' : 'buyer-ed25519-complete-body',
    ...(sessionDelegation ? { delegation: 'seller-session-delegation/v1' } : {}), response: 'seller-ed25519-request-bound', durability: 'seller-intent-journal' });
  const capability = Object.freeze({ declaration, sessionDelegation, authenticationFor(operation) {
    const auth = authenticationFor(operation);
    if (!exact(auth, ['request', 'verifyResponse']) || typeof auth.request !== 'function' || typeof auth.verifyResponse !== 'function') {
      throw new TypeError('the exact existing seller client authentication adapter is unavailable');
    }
    return auth;
  } });
  capabilities.add(capability);
  return capability;
}

export function sourceDemoSellerTransportConfig(value) {
  if (value == null) return null;
  if (!capabilities.has(value)) throw new TypeError('sellerTransport requires a constructed signed-peer capability');
  return value;
}
