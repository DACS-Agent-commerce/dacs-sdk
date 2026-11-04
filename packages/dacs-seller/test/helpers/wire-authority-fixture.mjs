// Test-only source of truth for the testnet binding (JS version of the wire's
// test/wire/authorityFixture.ts). Production installs an independently
// authenticated reader (P22); this fixture is never in the package `files`
// and never a production substitute.
import { TESTNET_PROFILE_TP1, TP1_APPROVED_IDENTITY_RECORD, TP1_BASE_REVISION, TP1_PROFILE_ID, TP1_PROFILE_REVISION } from '@kynesyslabs/dacs/wire';

export const TEST_CONNECTION = Object.freeze({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', connectionId: 'vector-conn-1' });
const AUTHORITY_PROVENANCE = 'test-only-independent-authority/v1';

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
