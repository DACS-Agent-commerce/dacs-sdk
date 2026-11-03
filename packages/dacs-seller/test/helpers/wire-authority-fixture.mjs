// Test-only source of truth for the testnet binding (JS version of the wire's
// test/wire/authorityFixture.ts). Production installs an independently
// authenticated reader (P22); this fixture is never in the package `files`
// and never a production substitute.
import { TESTNET_PROFILE_TP1, TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION } from '@kynesyslabs/dacs/wire';

export const TEST_CONNECTION = Object.freeze({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', connectionId: 'vector-conn-1' });
const AUTHORITY_PROVENANCE = 'test-only-independent-authority/v1';

/** The TP-1 tuple the fixture authority confirms: the one a wire host keeps for each purchase. */
export const FIXTURE_PROFILE = Object.freeze({ id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION,
  chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion });
const WIRE_ROUTES = new Set(['/dacs/v1/agreements/proposals', '/dacs/v1/agreements/state', '/dacs/v1/commitments', '/dacs/v1/commitments/signature']);

/**
 * `store` with the fixture tuple supplied on every `reserve` and `classify` of a route the signed wire opens, as the wire
 * host supplies it, for store-level tests of those routes. Every other route, and a call that names `keepProfile` itself (even as
 * `undefined`, to reserve with no tuple), is left as given.
 */
export function withFixtureProfile(store) {
  const supplied = (request, options = {}) => (!Object.hasOwn(options, 'keepProfile') && WIRE_ROUTES.has(request?.path) ? { ...options, keepProfile: FIXTURE_PROFILE } : options);
  return new Proxy(store, { get: (target, key) => {
    if (key === 'reserve') return (request, body, options) => target.reserve(request, body, supplied(request, options));
    if (key === 'classify') return (request, body, options) => target.classify(request, body, supplied(request, options));
    return Reflect.get(target, key, target);
  } });
}

/** A reader that confirms `chainIdentity` (the approved record's by default) for exactly the connection and participants it is asked about. */
export function authorityReader({ chainIdentity = TP1_APPROVED_IDENTITY_RECORD.chainIdentity } = {}) {
  const profile = { id: TP1_PROFILE_ID, revision: TP1_PROFILE_REVISION, base: TP1_BASE_REVISION, chainIdentity, pinVersion: TP1_APPROVED_IDENTITY_RECORD.pinVersion };
  return (scope) => ({
    local: { ...scope.local }, chainIdentity, provenance: AUTHORITY_PROVENANCE, sessionId: scope.sessionId,
    participants: scope.participants.map((claim) => ({ claim, profile, modules: TESTNET_PROFILE_TP1.tuple })),
  });
}

/** The host's `tp1Network` option over TEST_CONNECTION, with each part replaceable. */
export function testNetwork({ connection = () => ({ ...TEST_CONNECTION }), readAuthority = authorityReader() } = {}) {
  return { connection, readAuthority };
}
