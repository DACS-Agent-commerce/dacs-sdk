// Client test reader returning Tp1AuthorityDecision shapes (wire profile.ts).
// It mirrors the wire's TypeScript fixture, which client .mjs tests cannot import.
// Tests only: never shipped and never a substitute for the production reader.
import { bindTp1Profile, TP1_APPROVED_IDENTITY_RECORD } from '@kynesyslabs/dacs/wire';

export const LOCAL = Object.freeze({ endpoint: 'https://rpc.example.invalid/', transportAuthority: 'vector-authority', connectionId: 'vector-conn-1' });

/** A reader whose answer a test can steer through `state`. */
export function createAuthorityFixture() {
  const state = { chainIdentity: TP1_APPROVED_IDENTITY_RECORD.chainIdentity, provenance: 'TEST-authority-1', participants: 0, calls: 0, gate: null, failure: null };
  const read = async (scope) => {
    state.calls++;
    if (state.gate) await state.gate(scope);
    if (state.failure) throw state.failure;
    return { local: { ...scope.local }, chainIdentity: state.chainIdentity, provenance: state.provenance, sessionId: scope.sessionId,
      participants: Array.from({ length: state.participants }, (_, i) => ({ claim: `TEST-claim-${i}`, profile: {}, modules: {} })) };
  };
  return { read, state };
}

/** A real binding over the approved record, with a mutable current connection. */
export async function bindFixture(overrides = {}) {
  const authority = createAuthorityFixture();
  const current = { ...LOCAL };
  const binding = await bindTp1Profile({ record: TP1_APPROVED_IDENTITY_RECORD, local: { ...LOCAL }, readAuthority: authority.read, ...overrides });
  return { binding, authority, current, currentLocal: () => ({ ...current }) };
}
